// FreeCodeZ fork(2026-09-24 移动端远程控制):自建薄 relay 的协议回归集成测试——
// 设备 register/challenge-response、手机 mobile_hello 配对、data 回环、第二手机 KICKED、
// rotate 刷新二维码踢旧手机且旧链接失效、错 proof 拒绝。把一次性实测固化为可重复用例。
// 合同见 docs/spec/web-remote-control.md §5 与 packages/server/src/relay/。
// 运行:node --import tsx --test packages/services/test/webRemoteRelayIntegration.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";

import {
  buildRelayAuthProof,
  generateRelayPassword,
  hashRelayPassword,
} from "@zcode/shared/web-remote-control/auth-node";

const HOST = "127.0.0.1";
// 按 PID 派生端口:并行测试/并行开发会同时起 relay,固定端口偶发 EADDRINUSE 会把好测试误判成挂。
const PORT = 38000 + (process.pid % 800);

interface JsonFrame {
  type?: string;
  [key: string]: unknown;
}

function openSocket(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/** 首连重试:工厂绑定与首个连接之间留一点启动窗口,避免偶发 ECONNREFUSED。 */
async function openSocketWithRetry(
  url: string,
  headers?: Record<string, string>,
  attempts = 5,
): Promise<WebSocket> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await openSocket(url, headers);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function send(ws: WebSocket, frame: JsonFrame): void {
  ws.send(JSON.stringify(frame));
}

/** 收集帧直到谓词命中（或超时）。 */
function waitForFrame(
  ws: WebSocket,
  predicate: (frame: JsonFrame) => boolean,
  timeoutMs = 5_000,
  captured: JsonFrame[] = [],
): Promise<JsonFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`waitForFrame timeout; captured=${JSON.stringify(captured)}`));
    }, timeoutMs);
    function onMessage(raw: unknown): void {
      const frame = JSON.parse(String(raw)) as JsonFrame;
      captured.push(frame);
      if (predicate(frame)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(frame);
      }
    }
    ws.on("message", onMessage);
  });
}

/**
 * 挂安全句柄的等待:并行 wait 里任一先抛出后,其余的超时拒绝必须有人接,
 * 否则 unhandledRejection 会盖掉真正的首个失败现场(实测踩过)。
 */
function safeWait(
  ws: WebSocket,
  predicate: (frame: JsonFrame) => boolean,
  timeoutMs?: number,
): Promise<JsonFrame> {
  const pending = waitForFrame(ws, predicate, timeoutMs);
  pending.catch(() => undefined);
  return pending;
}

const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const meta = { platform: "test", version: "0.0.0", name: "test-device" };

/** 桌面设备侧完整握手，返回 {ws, deviceSid, passHash, frames}。 */
async function connectDevice(mid: string): Promise<{
  ws: WebSocket;
  deviceSid: string;
  passHash: string;
}> {
  const password = generateRelayPassword();
  const passHash = hashRelayPassword(password);
  // passHash 是标准 base64(可含 +/),URL 查询串必须百分号编码——`+` 会被解码成空格
  // 导致 "hash mismatch"(实测 ~50% 概率,恰好是 base64 不含 + 的概率)。
  const ws = await openSocketWithRetry(
    `ws://${HOST}:${PORT}/ws?mid=${encodeURIComponent(mid)}`,
    { "X-Device-ID": mid },
  );
  send(ws, {
    type: "device_register_init",
    device_mid: mid,
    pass_hash: passHash,
    meta,
    client_ts: Date.now(),
  });
  const ack = await waitForFrame(ws, (f) => f.type === "device_register_ack");
  const deviceSid = String(ack.device_sid);
  send(ws, { type: "auth_init", role: "device", device_sid: deviceSid, meta, client_ts: Date.now() });
  const challenge = await waitForFrame(ws, (f) => f.type === "auth_challenge");
  send(ws, {
    type: "auth_response",
    device_sid: deviceSid,
    proof: buildRelayAuthProof(passHash, String(challenge.nonce), deviceSid),
    client_ts: Date.now(),
  });
  await waitForFrame(ws, (f) => f.type === "auth_ack");
  return { ws, deviceSid, passHash };
}

/** 手机侧握手（mobile_hello），返回 auth_ack。 */
async function connectMobile(deviceSid: string, passHash: string): Promise<WebSocket> {
  const ws = await openSocketWithRetry(
    `ws://${HOST}:${PORT}/ws?sid=${encodeURIComponent(deviceSid)}&hash=${encodeURIComponent(passHash)}`,
  );
  send(ws, { type: "mobile_hello", sid: deviceSid, hash: passHash, client_ts: Date.now() });
  await waitForFrame(ws, (f) => f.type === "auth_ack");
  return ws;
}

test("relay 集成:设备握手/手机配对/data 回环/第二手机 KICKED/rotate 失效/错 proof 拒绝", async () => {
  const { createWebRemoteRelayServer } = await import("@zcode/server");
  const relay = createWebRemoteRelayServer({ host: HOST, port: PORT, logLevel: "silent" });
  const sockets: WebSocket[] = [];
  try {
    // 1) 设备握手:register → challenge → proof → auth_ack(waiting)
    const device = await connectDevice("mid-it-1");
    sockets.push(device.ws);

    // 2) 手机配对:mobile_hello → matched;设备收 pair_status_ack{matched} 推送
    const pairedPush = safeWait(device.ws, (f) => f.type === "pair_status_ack" && f.pair_status === "matched");
    const mobileA = await connectMobile(device.deviceSid, device.passHash);
    sockets.push(mobileA);
    await pairedPush;
    await settle();

    // 3) data 双向回环(payload 原样 + server_ts 盖章)
    const downWait = safeWait(mobileA, (f) => f.type === "data");
    send(device.ws, {
      type: "data",
      payload: { zcode_type: "bootstrap-request", requestId: "1" },
      client_ts: Date.now(),
    });
    const down = await downWait;
    assert.deepEqual(down.payload, { zcode_type: "bootstrap-request", requestId: "1" });
    assert.equal(typeof down.server_ts, "number");

    const upWait = safeWait(device.ws, (f) => f.type === "data");
    send(mobileA, {
      type: "data",
      payload: { zcode_type: "mobile-view-state-update", viewState: { updatedAt: 1 } },
      client_ts: Date.now(),
    });
    await upWait;
    await settle();

    // 4) 第二手机接管:前手机收 error{KICKED};新手机 matched
    const kickedWait = safeWait(mobileA, (f) => f.type === "error" && f.code === "KICKED");
    const mobileB = await connectMobile(device.deviceSid, device.passHash);
    sockets.push(mobileB);
    await kickedWait;
    await settle();

    // 5) rotate(刷新二维码):同 mid 重注册新 pass_hash → 现役手机被踢、旧 hash 失效
    const rotatedKick = safeWait(mobileB, (f) => f.type === "error" && f.code === "KICKED");
    const newHash = hashRelayPassword(generateRelayPassword());
    send(device.ws, {
      type: "device_register_init",
      device_mid: "mid-it-1",
      pass_hash: newHash,
      meta,
      client_ts: Date.now(),
    });
    await waitForFrame(device.ws, (f) => f.type === "device_register_ack");
    await rotatedKick;
    await settle();

    const stale = await openSocket(
      `ws://${HOST}:${PORT}/ws?sid=${encodeURIComponent(device.deviceSid)}&hash=${encodeURIComponent(device.passHash)}`,
    );
    sockets.push(stale);
    send(stale, { type: "mobile_hello", sid: device.deviceSid, hash: device.passHash, client_ts: Date.now() });
    const staleReply = await waitForFrame(stale, (f) => f.type === "error" || f.type === "auth_ack");
    assert.equal(staleReply.type, "error", "旧 hash 的手机连接必须被拒");
    assert.equal(staleReply.code, "AUTH_FAILED");

    // 6) 错 proof → AUTH_FAILED
    const badDevice = await openSocket(`ws://${HOST}:${PORT}/ws?mid=mid-it-2`, {
      "X-Device-ID": "mid-it-2",
    });
    sockets.push(badDevice);
    const badHash = hashRelayPassword(generateRelayPassword());
    send(badDevice, {
      type: "device_register_init",
      device_mid: "mid-it-2",
      pass_hash: badHash,
      meta,
      client_ts: Date.now(),
    });
    const badAck = await waitForFrame(badDevice, (f) => f.type === "device_register_ack");
    send(badDevice, {
      type: "auth_init",
      role: "device",
      device_sid: String(badAck.device_sid),
      meta,
      client_ts: Date.now(),
    });
    const badChallenge = await waitForFrame(badDevice, (f) => f.type === "auth_challenge");
    send(badDevice, {
      type: "auth_response",
      device_sid: String(badAck.device_sid),
      proof: buildRelayAuthProof(hashRelayPassword(generateRelayPassword()), String(badChallenge.nonce), String(badAck.device_sid)),
      client_ts: Date.now(),
    });
    const badReply = await waitForFrame(badDevice, (f) => f.type === "error" || f.type === "auth_ack");
    assert.equal(badReply.type, "error");
    assert.equal(badReply.code, "AUTH_FAILED");
  } finally {
    for (const ws of sockets) {
      ws.close();
    }
    await relay.close();
  }
});
