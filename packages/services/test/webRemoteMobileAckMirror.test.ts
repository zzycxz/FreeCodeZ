// FreeCodeZ fork(2026-09-24 移动端远程控制):AcknowledgedRelayProtocol 手机侧镜像单测——
// 分片重组镜像(≤64 片/16MB/1MB 物理帧/crc32/seq 去重)、累计 ack 只增不减、futureAck 终态降级、
// 重放未确认批次、重放缓冲累计释放。语义合同见附录A §3。
// 运行:node --import tsx --test packages/services/test/webRemoteMobileAckMirror.test.ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  base64ToBytes,
  bytesToBase64,
  createRelayAckMirror,
  createRelayReplayBuffer,
  encodeMessageFrames,
  type RelayAckMirrorOptions,
} from "../../client/src/relayAckMirror.js";
import type { RpcFrame, RpcFrameAck } from "@zcode/shared/web-remote-control";

const IDENTITY = { bridgeSessionId: "bridge-1" };

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function collectFrames(): {
  frames: Array<RpcFrame | RpcFrameAck>;
  options: Pick<RelayAckMirrorOptions, "sendFrame">;
} {
  const frames: Array<RpcFrame | RpcFrameAck> = [];
  return {
    frames,
    options: {
      sendFrame: (frame) => {
        frames.push(frame);
        return true;
      },
    },
  };
}

test("base64 往返:规范形式,非法输入返回 null", () => {
  for (const length of [0, 1, 2, 3, 4, 5, 512, 1023]) {
    const bytes = new Uint8Array(length).map((_, index) => (index * 37) % 256);
    const encoded = bytesToBase64(bytes);
    assert.deepEqual(base64ToBytes(encoded), bytes, `length=${length} 往返失败`);
  }
  assert.equal(base64ToBytes("abc"), null, "长度非 4 倍数必须拒绝");
  assert.equal(base64ToBytes("a=b="), null, "padding 位置非法必须拒绝");
});

test("分片编码:600KB 切 2 片,逐帧 ≤1MB,checksum 为整段 crc32", () => {
  const bytes = new Uint8Array(600 * 1024).map((_, index) => index % 251);
  const encoded = encodeMessageFrames({
    identity: IDENTITY,
    bytes,
    messageSeq: 1,
    startFrameSeq: 0,
  });
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;
  assert.equal(encoded.frames.length, 2, "600KB > 512KB 片上限,应切成 2 片");
  assert.equal(encoded.frames[0]!.fragmentCount, 2);
  assert.equal(encoded.frames[0]!.messageBytes, bytes.byteLength);
  assert.equal(encoded.frames[0]!.checksum.value, encoded.frames[1]!.checksum.value);
  for (const frame of encoded.frames) {
    assert.ok(JSON.stringify(frame).length <= 1 << 20, "物理帧硬限 1MB");
  }
  // 空消息与超 16MB 消息都是编码失败
  assert.equal(
    encodeMessageFrames({ identity: IDENTITY, bytes: new Uint8Array(0), messageSeq: 2, startFrameSeq: 0 }).ok,
    false,
  );
  assert.equal(
    encodeMessageFrames({
      identity: IDENTITY,
      bytes: new Uint8Array(16 * 1024 * 1024 + 1),
      messageSeq: 3,
      startFrameSeq: 0,
    }).ok,
    false,
  );
});

test("重组镜像:多片重组交付一次,重复帧幂等,checksum 破坏 → invalidPayload 降级", () => {
  const bytes = new Uint8Array(700 * 1024).map((_, index) => (index * 13) % 256);
  const encoded = encodeMessageFrames({ identity: IDENTITY, bytes, messageSeq: 1, startFrameSeq: 0 });
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;

  const delivered: Uint8Array[] = [];
  const faults: string[] = [];
  const receiver = createRelayAckMirror({
    ...IDENTITY,
    ...collectFrames().options,
    sendFrame: () => true,
  });
  receiver.onMessage((buffer) => delivered.push(buffer));
  receiver.onDegraded((fault) => faults.push(fault.reasonCode));

  receiver.acceptPayload(encoded.frames[0]!);
  assert.equal(delivered.length, 0, "半包不得交付");
  receiver.acceptPayload(encoded.frames[1]!);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0], bytes, "重组字节必须与原消息全等");

  // 重放的旧帧(seq ≤ 已见最大 seq)幂等接受,不再触发交付/故障
  receiver.acceptPayload(encoded.frames[0]!);
  receiver.acceptPayload(encoded.frames[1]!);
  assert.equal(delivered.length, 1);
  assert.deepEqual(faults, []);
  receiver.dispose();

  // 破坏单片消息的 checksum → 重组后校验失败
  const single = encodeMessageFrames({
    identity: IDENTITY,
    bytes: textBytes("hello"),
    messageSeq: 1,
    startFrameSeq: 0,
  });
  assert.equal(single.ok, true);
  if (!single.ok) return;
  const brokenReceiver = createRelayAckMirror({ ...IDENTITY, sendFrame: () => true });
  const brokenFaults: string[] = [];
  const brokenDelivered: Uint8Array[] = [];
  brokenReceiver.onMessage((buffer) => brokenDelivered.push(buffer));
  brokenReceiver.onDegraded((fault) => brokenFaults.push(fault.reasonCode));
  const tampered: RpcFrame = {
    ...single.frames[0]!,
    checksum: { algorithm: "crc32", value: "00000000" },
    seq: 10,
  };
  brokenReceiver.acceptPayload(tampered);
  assert.equal(brokenDelivered.length, 0);
  assert.deepEqual(brokenFaults, ["remote.rpcFrame.invalidPayload"]);
  brokenReceiver.dispose();
});

test("累计 ack:只增不减、释放重放缓冲;futureAck 终态降级", () => {
  const senderFrames = collectFrames();
  let clock = 1_000;
  const sender = createRelayAckMirror({
    ...IDENTITY,
    ...senderFrames.options,
    now: () => clock,
  });

  sender.protocol.send(textBytes("one"));
  sender.protocol.send(textBytes("two"));
  const dataFrames = senderFrames.frames.filter((frame) => "zcode_type" in frame && frame.zcode_type === "rpc-frame");
  assert.equal(dataFrames.length, 2, "两条消息 = 两个单片批次");
  assert.ok(sender.unacknowledgedBytes > 0);

  // 累计 ack=1 释放首批;重复 ack=1 与更小的 ack 不回退
  sender.acceptPayload({ zcode_type: "rpc-frame-ack", ...IDENTITY, ackMessageSeq: 1 });
  const afterFirst = sender.unacknowledgedBytes;
  sender.acceptPayload({ zcode_type: "rpc-frame-ack", ...IDENTITY, ackMessageSeq: 1 });
  sender.acceptPayload({ zcode_type: "rpc-frame-ack", ...IDENTITY, ackMessageSeq: 1 });
  assert.equal(sender.unacknowledgedBytes, afterFirst, "旧 ack 必须被忽略");

  // ack=2 全部释放
  sender.acceptPayload({ zcode_type: "rpc-frame-ack", ...IDENTITY, ackMessageSeq: 2 });
  assert.equal(sender.unacknowledgedBytes, 0);

  // futureAck(> highestFullySent)→ terminal 降级
  const faults: string[] = [];
  sender.onDegraded((fault) => faults.push(`${fault.reasonCode}:${fault.terminal}`));
  sender.acceptPayload({ zcode_type: "rpc-frame-ack", ...IDENTITY, ackMessageSeq: 9 });
  assert.deepEqual(faults, ["remote.rpcFrame.futureAck:true"]);
  assert.equal(sender.isDegraded(), true);
  assert.equal(sender.acceptPayload({ zcode_type: "rpc-frame-ack", ...IDENTITY, ackMessageSeq: 10 }), false);
  sender.dispose();
});

test("重放:replayUnacknowledged 重发未确认批次;ack 停滞超宽限 → ackGraceExceeded 终态", () => {
  const senderFrames = collectFrames();
  let clock = 10_000;
  const sender = createRelayAckMirror({
    ...IDENTITY,
    ...senderFrames.options,
    now: () => clock,
    replayBufferGraceMs: 45_000,
  });
  sender.protocol.send(textBytes("payload"));
  const sentOnce = senderFrames.frames.length;
  assert.equal(sentOnce, 1);
  assert.equal(sender.replayUnacknowledged(), true);
  assert.equal(senderFrames.frames.length, 2, "重放必须重发全部未确认帧");

  const faults: string[] = [];
  sender.onDegraded((fault) => faults.push(fault.reasonCode));
  clock += 46_000;
  sender.protocol.send(textBytes("trigger-maintenance"));
  assert.ok(faults.includes("remote.rpcFrame.ackGraceExceeded"));
  assert.equal(sender.isDegraded(), true);
  sender.dispose();
});

test("重放缓冲:8MB 上限与累计释放压缩", () => {
  const buffer = createRelayReplayBuffer({ maxBytes: 1_000, now: () => 0 });
  const batch = (messageSeq: number, outerBytes: number) => ({
    messageSeq,
    frames: [],
    outerBytes,
    queuedAt: 0,
    nextFrameIndex: 0,
  });
  assert.deepEqual(buffer.enqueue(batch(1, 600)), { ok: true });
  assert.deepEqual(buffer.enqueue(batch(2, 600)), {
    ok: false,
    reason: "remote.rpcFrame.replayBufferExceeded",
  });
  buffer.releaseThrough(1);
  assert.equal(buffer.unacknowledgedBytes(), 0);
  assert.deepEqual(buffer.enqueue(batch(2, 900)), { ok: true });
  buffer.releaseThrough(2);
  assert.equal(buffer.unacknowledgedBytes(), 0);
});
