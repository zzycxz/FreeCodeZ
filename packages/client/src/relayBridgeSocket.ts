import { type MessagePortLike, type MessagePortPayload, MessagePortProtocol } from "@zcode/rpc";
import type { BridgeSessionIdentity } from "@zcode/shared/web-remote-control";

// RelayMobileBridgeChannel → MessagePortLike 适配。手机桥两端必须同为 MessagePort 语义：
// 桌面 Host 的 attachment 口是 exposeServicesOnMessagePort → MessagePortProtocol（ChannelServer
// attach 即发 Initialize 握手，等 ChannelClient 收到后才放行请求），而 main 的 startBridgeBytePump
// 把每条 relay message 原样 postMessage 进 Host port——即「一条 relay message = 一条 RPC 消息」。
// 手机侧此前套了 SocketProtocol（13 字节分帧头）：Host 的 6 字节 Initialize 永远凑不齐帧头，
// ChannelClient 的 whenInitialized 永不 resolve，所有 RPC 请求排队不发，会话 snapshot 到不了，
// 手机会话页输入框永久禁用（2026-09-28 真机扫码复现定位）。

export interface RelayMobileBridgeChannel {
  identity: BridgeSessionIdentity;
  sendBytes(bytes: Uint8Array): void;
  onBytes(callback: (bytes: Uint8Array) => void): { dispose(): void };
  onClosed(callback: () => void): { dispose(): void };
  drain(): Promise<void>;
  close(): void;
}

/**
 * 桥通道 → MessagePortLike：每条重组完成的 relay message 作为一条 RPC 消息上抛；
 * 出站 postMessage（ArrayBuffer 或 Uint8Array）还原成 Uint8Array 后按一条 message 发送。
 */
export function wrapRelayBridgeMessagePort(channel: RelayMobileBridgeChannel): MessagePortLike {
  const listeners = new Set<(event: { data: MessagePortPayload }) => void>();
  const bytesSub = channel.onBytes((bytes) => {
    // 快照遍历，防 listener 内部增删导致迭代失效。
    for (const listener of Array.from(listeners)) {
      listener({ data: bytes });
    }
  });
  return {
    addEventListener(type, listener) {
      if (type === "message") listeners.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.delete(listener);
    },
    postMessage(message) {
      // MessagePortProtocol.send 传入 VSBuffer.buffer（ArrayBuffer）；同时容忍 Uint8Array。
      if (message instanceof ArrayBuffer) channel.sendBytes(new Uint8Array(message));
      else if (message instanceof Uint8Array) channel.sendBytes(message);
    },
    start() {
      // 字节订阅在构造时已建立；MessagePort 语义无需显式 start。
    },
    close() {
      bytesSub.dispose();
      listeners.clear();
      channel.close();
    },
  };
}

/** 手机桥的 RPC 协议端：MessagePortProtocol，与桌面 Host attachment 口同语义。 */
export function createRelayBridgeProtocol(channel: RelayMobileBridgeChannel): MessagePortProtocol {
  return new MessagePortProtocol(wrapRelayBridgeMessagePort(channel));
}
