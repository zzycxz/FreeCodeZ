import {
  WEB_REMOTE_CONTROL_LIMITS,
  authAckSchema,
  isRawTransportCandidate,
  pairStatusAckSchema,
  relayDataEnvelopeSchema,
  relayErrorSchema,
  type BridgeSessionIdentity,
  type FailureReason,
  type RpcFrame,
  type RpcFrameAck,
} from "@zcode/shared/web-remote-control";
import { createRelayAckMirror } from "./relayAckMirror.js";
import type { RelayMobileBridgeChannel } from "./relayBridgeSocket.js";

export type { RelayMobileBridgeChannel } from "./relayBridgeSocket.js";

// 浏览器侧 relay WS 客户端（手机握手契约见 server/relay/mobilePage.ts）：
//   GET /ws?sid&hash 升级 → 首帧 {type:"mobile_hello", sid, hash, client_ts?} → auth_ack{pair_status}
//   数据面 {type:"data", payload:<AppMessage|RpcFrame|RpcFrameAck>, client_ts?} 双向。
// 传输状态机区分可重连（网络断开/INTERNAL）与终态（KICKED=session-conflict、rotate/鉴权失效），
// 断线横幅与重试文案直接消费本状态（spec W2：不复刻官方死 store）。
// workspace-bridge-ready 之后，rpc-frame 通道承载 Host MessagePort 上的 channel RPC 字节流：
// 每个桥一个 AcknowledgedRelayProtocol 镜像（relayAckMirror.ts），再经 ISocket 适配交给
// SocketProtocol/ChannelClient/RemoteServiceAccess（与 packages/web 相同的服务面）。

export type RelayMobilePhase =
  | "connecting"
  | "waiting-pair"
  | "paired"
  | "reconnecting"
  | "session-conflict"
  | "invalid-connection"
  | "relay-error"
  | "stopped";

export interface RelayMobileFailure {
  reason: FailureReason;
  message: string;
}

export interface RelayMobileTransportState {
  phase: RelayMobilePhase;
  pairStatus?: "waiting" | "matched";
  failure?: RelayMobileFailure;
}

export interface RelayMobileTransportOptions {
  wsUrl: string;
  sid: string;
  hash: string;
  /** 重连延迟抖动上限（默认 WEB_REMOTE_CONTROL_LIMITS.reconnectJitterMaxMs=纯抖动 U[0,2s]）。 */
  reconnectJitterMaxMs?: number;
  /** 测试注入。 */
  WebSocketImpl?: typeof WebSocket;
  random?: () => number;
  now?: () => number;
}

export interface RelayMobileTransport {
  readonly state: RelayMobileTransportState;
  onStateChange(callback: (state: RelayMobileTransportState) => void): { dispose(): void };
  /** 应用层 data.payload 发送（AppMessage / rpc-frame 直通）。 */
  send(payload: unknown): boolean;
  /** 非 rpc-frame 的应用层 payload 订阅。 */
  onPayload(callback: (payload: unknown) => void): { dispose(): void };
  openBridge(identity: BridgeSessionIdentity): RelayMobileBridgeChannel;
  closeBridge(bridgeSessionId: string): void;
  dispose(): void;
}

type Listener<T> = { callback: (value: T) => void };

function addListener<T>(set: Set<Listener<T>>, callback: (value: T) => void): { dispose(): void } {
  const listener: Listener<T> = { callback };
  set.add(listener);
  return {
    dispose: () => {
      set.delete(listener);
    },
  };
}

/** relay error 帧 → 手机侧失败语义（KICKED/rotate → session-conflict + kicked 分流；鉴权失效 → session-not-found）。 */
export function mapRelayErrorToFailure(code: string, message?: string): RelayMobileFailure {
  const text = message ?? "";
  if (code === "KICKED") {
    return { reason: "session-conflict", message: text.includes("kicked") ? text : `kicked: ${text}` };
  }
  if (code === "AUTH_FAILED") {
    const reason: FailureReason =
      text.includes("invalid-mobile-connection") || text.includes("hash")
        ? "invalid-mobile-connection"
        : "session-not-found";
    return { reason, message: text || reason };
  }
  if (code === "WRONG_PARAM") return { reason: "invalid-mobile-connection", message: text || code };
  return { reason: "relay-unavailable", message: text || code };
}

interface BridgeEntry {
  identity: BridgeSessionIdentity;
  mirror: ReturnType<typeof createRelayAckMirror>;
  byteListeners: Set<Listener<Uint8Array>>;
  closeListeners: Set<Listener<void>>;
}

export function connectRelayMobileTransport(options: RelayMobileTransportOptions): RelayMobileTransport {
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => Date.now());
  const jitterMax = options.reconnectJitterMaxMs ?? WEB_REMOTE_CONTROL_LIMITS.reconnectJitterMaxMs;

  const stateListeners = new Set<Listener<RelayMobileTransportState>>();
  const payloadListeners = new Set<Listener<unknown>>();
  const bridges = new Map<string, BridgeEntry>();

  let state: RelayMobileTransportState = { phase: "connecting" };
  let ws: WebSocket | null = null;
  let disposed = false;
  let terminal = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function setState(next: RelayMobileTransportState): void {
    state = next;
    for (const listener of Array.from(stateListeners)) {
      try {
        listener.callback(next);
      } catch {
        // 监听器异常不得影响传输状态机。
      }
    }
  }

  function closeAllBridges(): void {
    for (const entry of Array.from(bridges.values())) {
      entry.mirror.dispose();
      for (const listener of Array.from(entry.closeListeners)) {
        try {
          listener.callback();
        } catch {
          // 忽略监听器异常
        }
      }
    }
  }

  function terminate(failure: RelayMobileFailure, phase: RelayMobilePhase): void {
    if (terminal) return;
    terminal = true;
    closeAllBridges();
    setState({ phase, failure });
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    try {
      ws?.close();
    } catch {
      // 已断开时忽略
    }
  }

  function scheduleReconnect(): void {
    if (disposed || terminal || reconnectTimer) return;
    setState({
      phase: "reconnecting",
      ...(state.pairStatus ? { pairStatus: state.pairStatus } : {}),
      ...(state.failure ? { failure: state.failure } : {}),
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, Math.floor(random() * jitterMax));
  }

  function sendRaw(frame: unknown): boolean {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  function send(payload: unknown): boolean {
    return sendRaw({ type: "data", payload, client_ts: now() });
  }

  function emitPayload(payload: unknown): void {
    for (const listener of Array.from(payloadListeners)) {
      try {
        listener.callback(payload);
      } catch {
        // 监听器异常不得影响数据面。
      }
    }
  }

  function handleDataFrame(payload: unknown): void {
    if (isRawTransportCandidate(payload)) {
      const bridgeSessionId = (payload as { bridgeSessionId?: unknown }).bridgeSessionId;
      const entry = typeof bridgeSessionId === "string" ? bridges.get(bridgeSessionId) : undefined;
      if (entry) {
        entry.mirror.acceptPayload(payload);
      }
      return;
    }
    emitPayload(payload);
  }

  function handleInbound(text: string): void {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const authAck = authAckSchema.safeParse(json);
    if (authAck.success) {
      const pairStatus = authAck.data.pair_status;
      setState({
        phase: pairStatus === "matched" ? "paired" : "waiting-pair",
        pairStatus,
        ...(state.failure ? { failure: state.failure } : {}),
      });
      // 重连完成后重放各桥未确认批次（ack 累计语义保证幂等）。
      if (pairStatus === "matched") {
        for (const entry of bridges.values()) {
          entry.mirror.replayUnacknowledged();
        }
      }
      return;
    }
    const pairAck = pairStatusAckSchema.safeParse(json);
    if (pairAck.success) {
      const pairStatus = pairAck.data.pair_status;
      // pair_status 回 waiting = 桌面断开（relay 配对表迁移推送）→ 进入可重连态。
      if (pairStatus === "waiting" && state.phase === "paired") {
        setState({ phase: "waiting-pair", pairStatus });
      } else {
        setState({ ...state, pairStatus });
      }
      return;
    }
    const error = relayErrorSchema.safeParse(json);
    if (error.success) {
      const failure = mapRelayErrorToFailure(error.data.code, error.data.message);
      const phase: RelayMobilePhase =
        error.data.code === "KICKED"
          ? "session-conflict"
          : error.data.code === "AUTH_FAILED" || error.data.code === "WRONG_PARAM"
            ? "invalid-connection"
            : "relay-error";
      // KICKED/rotate 与鉴权失效/参数错误都是终态，不再自动重连（需回到桌面重新扫码）；
      // WRONG_PARAM 虽多为瞬时帧序问题，但连接已被 relay 关闭，保留终态语义避免死循环重连。
      terminate(failure, phase);
      return;
    }
    const envelope = relayDataEnvelopeSchema.safeParse(json);
    if (envelope.success) {
      handleDataFrame(envelope.data.payload);
    }
  }

  function open(): void {
    if (disposed || terminal) return;
    setState({
      phase: state.phase === "reconnecting" ? "reconnecting" : "connecting",
      ...(state.pairStatus ? { pairStatus: state.pairStatus } : {}),
    });
    const url = new URL(options.wsUrl);
    url.searchParams.set("sid", options.sid);
    url.searchParams.set("hash", options.hash);
    let socket: WebSocket;
    try {
      socket = new WebSocketImpl(url.toString());
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;
    socket.addEventListener("open", () => {
      sendRaw({ type: "mobile_hello", sid: options.sid, hash: options.hash, client_ts: now() });
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") handleInbound(event.data);
    });
    socket.addEventListener("close", () => {
      if (ws === socket) ws = null;
      if (disposed || terminal) return;
      scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      // onclose 统一收口，这里只保证连接失败时不会静默悬挂。
    });
  }

  function openBridge(identity: BridgeSessionIdentity): RelayMobileBridgeChannel {
    const existing = bridges.get(identity.bridgeSessionId);
    if (existing) {
      closeBridge(identity.bridgeSessionId);
    }
    const byteListeners = new Set<Listener<Uint8Array>>();
    const closeListeners = new Set<Listener<void>>();
    const mirror = createRelayAckMirror({
      bridgeSessionId: identity.bridgeSessionId,
      ...(identity.bridgeGeneration == null ? {} : { bridgeGeneration: identity.bridgeGeneration }),
      ...(identity.recoveryId == null ? {} : { recoveryId: identity.recoveryId }),
      sendFrame: (frame: RpcFrame | RpcFrameAck) => send(frame),
      now,
    });
    mirror.onMessage((bytes) => {
      for (const listener of Array.from(byteListeners)) {
        try {
          listener.callback(bytes);
        } catch {
          // 忽略监听器异常
        }
      }
    });
    const entry: BridgeEntry = { identity, mirror, byteListeners, closeListeners };
    bridges.set(identity.bridgeSessionId, entry);
    return {
      identity,
      sendBytes: (bytes) => mirror.protocol.send(bytes),
      onBytes: (callback) => addListener(byteListeners, callback),
      onClosed: (callback) => addListener(closeListeners, callback),
      drain: () => mirror.protocol.drain(),
      close: () => closeBridge(identity.bridgeSessionId),
    };
  }

  function closeBridge(bridgeSessionId: string): void {
    const entry = bridges.get(bridgeSessionId);
    if (!entry) return;
    bridges.delete(bridgeSessionId);
    entry.mirror.dispose();
    for (const listener of Array.from(entry.closeListeners)) {
      try {
        listener.callback();
      } catch {
        // 忽略监听器异常
      }
    }
  }

  open();

  return {
    get state(): RelayMobileTransportState {
      return state;
    },
    onStateChange: (callback) => addListener(stateListeners, callback),
    send,
    onPayload: (callback) => addListener(payloadListeners, callback),
    openBridge,
    closeBridge,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      closeAllBridges();
      setState({ phase: "stopped" });
      try {
        ws?.close();
      } catch {
        // 已断开时忽略
      }
      ws = null;
    },
  };
}
