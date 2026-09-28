// FreeCodeZ fork(2026-09-28 手机会话页输入框修复):手机桥 RPC 协议互通回归。
// 背景:桌面 Host attachment 口是 MessagePortProtocol(ChannelServer attach 即发 Initialize),
// 桥的字节语义是「一条 relay message = 一条 RPC 消息」;手机侧曾误用 SocketProtocol(13 字节
// 分帧头),Initialize 永远凑不齐帧头,ChannelClient whenInitialized 永不 resolve,所有 RPC
// 排队不发——snapshot 到不了,会话页输入框永久禁用。本文件锁定两端协议互通与补发语义。
// 运行:node --import tsx --test packages/services/test/webRemoteMobileBridgeRpc.test.ts
import assert from "node:assert/strict";
import test from "node:test";

import { ChannelClient, ChannelServer, MessagePortProtocol } from "@zcode/rpc";
import {
  createRelayBridgeProtocol,
  wrapRelayBridgeMessagePort,
  type RelayMobileBridgeChannel,
} from "../../client/src/relayBridgeSocket.js";
import { createRelayMobileSession } from "../../../packages/web/src/mobile/relayMobileSession.js";
import type { BridgeSessionIdentity } from "@zcode/shared/web-remote-control";

const IDENTITY: BridgeSessionIdentity = { bridgeSessionId: "bridge-test-1" };

/** 内存桥通道对:一侧 sendBytes 直推「另一侧」的 onBytes(保留 message 边界,与 relay 重组语义一致)。 */
function createInMemoryBridgePair(): [RelayMobileBridgeChannel, RelayMobileBridgeChannel] {
  const listenersBySide: [Set<(bytes: Uint8Array) => void>, Set<(bytes: Uint8Array) => void>] = [
    new Set(),
    new Set(),
  ];
  function makeSide(index: 0 | 1): RelayMobileBridgeChannel {
    return {
      identity: IDENTITY,
      sendBytes(bytes) {
        const peerListeners = listenersBySide[index === 0 ? 1 : 0];
        const copy = new Uint8Array(bytes);
        queueMicrotask(() => {
          for (const listener of Array.from(peerListeners)) listener(copy);
        });
      },
      onBytes(callback) {
        listenersBySide[index].add(callback);
        return { dispose: () => listenersBySide[index].delete(callback) };
      },
      onClosed() {
        return { dispose: () => {} };
      },
      drain() {
        return Promise.resolve();
      },
      close() {},
    };
  }
  return [makeSide(0), makeSide(1)];
}

test("桥 RPC 互通:ChannelServer(Host 语义) ↔ MessagePortProtocol(手机桥) 请求/响应/事件", async () => {
  const [hostChannel, mobileChannel] = createInMemoryBridgePair();
  // Host 侧复刻 exposeServicesOnMessagePort:MessagePortProtocol + ChannelServer(attach 即 Initialize)。
  const server = new ChannelServer(
    new MessagePortProtocol(wrapRelayBridgeMessagePort(hostChannel)),
    "host",
    1000,
  );
  server.registerChannel("echo", {
    async call(_ctx, command: string, arg?: unknown) {
      if (command === "ping") return { pong: arg ?? null };
      throw new Error(`unknown command: ${command}`);
    },
    listen() {
      return () => {};
    },
  });
  // 手机侧:修复后的桥协议端 + ChannelClient(所有请求在 Initialize 之后才放行)。
  const client = new ChannelClient(createRelayBridgeProtocol(mobileChannel));
  const channel = client.getChannel("echo");
  const result = await channel.call("ping", { hello: "world" });
  assert.deepEqual(result, { pong: { hello: "world" } });
  await assert.rejects(() => channel.call("nope"), /unknown command: nope/);
  client.dispose();
  server.dispose();
});

test("消息边界:一条 relay message 直达一条 RPC 消息,postMessage(ArrayBuffer) 还原为 sendBytes", async () => {
  const sent: Uint8Array[] = [];
  const pending: Array<(bytes: Uint8Array) => void> = [];
  const channel: RelayMobileBridgeChannel = {
    identity: IDENTITY,
    sendBytes(bytes) {
      sent.push(new Uint8Array(bytes));
    },
    onBytes(callback) {
      pending.push(callback);
      return { dispose: () => {} };
    },
    onClosed() {
      return { dispose: () => {} };
    },
    drain() {
      return Promise.resolve();
    },
    close() {},
  };
  const port = wrapRelayBridgeMessagePort(channel);
  const events: Uint8Array[] = [];
  port.addEventListener("message", (event) => {
    assert.ok(event.data instanceof Uint8Array, "桥只应上抛 Uint8Array");
    events.push(event.data);
  });
  // 注册完成后再回放三条边界不同的消息,验证不拼接、不分帧。
  for (const emit of pending) {
    emit(new Uint8Array([1, 2]));
    emit(new Uint8Array([3]));
    emit(new TextEncoder().encode("four"));
  }
  assert.equal(events.length, 3, "每条 relay message 应各自触发一次 listener");
  assert.deepEqual(Array.from(events[0]), [1, 2]);
  assert.deepEqual(Array.from(events[1]), [3]);
  assert.deepEqual(new TextDecoder().decode(events[2]), "four");
  // MessagePortProtocol.send 传 VSBuffer.buffer(ArrayBuffer):适配层必须还原成 Uint8Array 发送。
  port.postMessage(new Uint8Array([9, 9, 9]).buffer);
  assert.equal(sent.length, 1);
  assert.deepEqual(Array.from(sent[0]), [9, 9, 9]);
  port.close();
});

/** 脚本化 WebSocket:构造后保持 CONNECTING,由测试推进 open/服务端帧。 */
class ScriptedWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  emitOpen() {
    this.readyState = 1;
    this.listeners.get("open")?.forEach((l) => l({}));
  }
  emitServerText(text: string) {
    this.listeners.get("message")?.forEach((l) => l({ data: text }));
  }
}

test("bootstrap 竞态:transport 未就绪时挂起,paired 后补发,不再立即失败", async () => {
  const sockets: ScriptedWebSocket[] = [];
  const WebSocketImpl = class extends ScriptedWebSocket {
    constructor(_url: string) {
      super();
      sockets.push(this);
    }
  } as unknown as typeof WebSocket;
  const session = createRelayMobileSession({
    wsUrl: "ws://127.0.0.1:39999/ws",
    sid: "sid-race",
    hash: "hash-race",
    name: "test",
    appVersion: "0",
    webSocketImpl: WebSocketImpl,
  });
  // 页面挂载先于 WS open:bootstrap 立即调用,此时 transport 仍在 connecting。
  let settled = false;
  const bootstrapPromise = session.bootstrap().then(
    (result) => {
      settled = true;
      return result;
    },
    (error) => {
      settled = true;
      throw error;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(settled, false, "transport 未就绪时 bootstrap 应挂起等待,而不是立即 reject");
  // 推进 WS:open → hello(transport 发出) → relay 回 auth_ack matched → transport paired。
  const socket = sockets[0] ?? null;
  assert.ok(socket, "transport 应已创建 WebSocket 实例");
  socket.emitOpen();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    socket.sent.some((frame) => frame.includes("mobile_hello")),
    "open 后应发出 mobile_hello",
  );
  socket.emitServerText(JSON.stringify({ type: "auth_ack", pair_status: "matched" }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(
    socket.sent.some((frame) => frame.includes("bootstrap-request")),
    "paired 后应补发 bootstrap-request",
  );
  socket.emitServerText(
    JSON.stringify({
      type: "data",
      payload: {
        zcode_type: "bootstrap-response",
        requestId: socket.sent
          .map((frame) => {
            try {
              return JSON.parse(frame).payload?.requestId;
            } catch {
              return undefined;
            }
          })
          .filter((id): id is string => Boolean(id))
          .at(-1),
        success: true,
        result: { windowControlSessionId: "wcs-test-1", workspaces: [], tasks: [] },
      },
      client_ts: Date.now(),
    }),
  );
  const result = (await bootstrapPromise) as { workspaces: unknown[] };
  assert.deepEqual(result.workspaces, []);
  session.dispose();
});
