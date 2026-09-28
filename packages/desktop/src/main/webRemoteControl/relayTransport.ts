import { WebSocket, type RawData } from "ws";
import {
  RPC_FRAME_LIMITS,
  WEB_REMOTE_CONTROL_LIMITS,
  resolveRelayWsUrl,
  type RelayDeviceMeta,
  type RelayInboundFrame,
  type RelayPairStatus,
  type RelayTransportState,
} from "@zcode/shared/web-remote-control";
import { buildRelayAuthProof } from "@zcode/shared/web-remote-control/auth-node";
import { parseRelayInbound } from "./relayFrameCodec.js";

// RelayTransport（附录A §1）：WSS 握手 device_register_init(pass_hash) → device_register_ack →
// auth_init → auth_challenge → auth_response(proof=buildRelayAuthProof) → auth_ack{pair_status}；
// 心跳 pair_status_query 10s±min(2s,20%) 抖动、ack 看门狗 30s、重连纯抖动 U[0,2s]（无基础延迟）、
// stale-waiting 恢复窗 15s、1MB 物理帧出入站防护。password 仅本地持有，从不上传。

export interface RelayTransportLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface RelayTransportEvents {
  onStateChanged(state: RelayTransportState): void;
  onPairStatusChanged(status: RelayPairStatus): void;
  /** 注册+鉴权完成（waiting_terminal 或 paired），携带 relay 分配的 deviceSid。 */
  onReady(deviceSid: string): void;
  onPaired(): void;
  onData(payload: unknown): void;
  onKicked(message: string): void;
  /** fatal=true 不再重连（AUTH_FAILED/WRONG_PARAM）；false 为重连中可恢复异常。 */
  onError(error: string, fatal: boolean): void;
}

export interface RelayTransportOptions {
  deviceMid: string;
  deviceMeta: () => RelayDeviceMeta;
  resolvePassHash: () => Promise<string>;
  persistDeviceSid: (deviceSid: string) => Promise<void>;
  resolveWsUrl?: () => string;
  logger: RelayTransportLogger;
  events: RelayTransportEvents;
  now?: () => number;
}

export interface RelayTransport {
  start(): void;
  stop(): void;
  /** 出站 data 信封；物理帧 >1MB 拒发。 */
  sendData(payload: unknown): boolean;
  getState(): RelayTransportState;
  getPairStatus(): RelayPairStatus;
  getDeviceSid(): string | undefined;
}

const RECONNECT_JITTER_MAX_MS = WEB_REMOTE_CONTROL_LIMITS.reconnectJitterMaxMs;
const HEARTBEAT_INTERVAL_MS = WEB_REMOTE_CONTROL_LIMITS.heartbeatIntervalMs;
const HEARTBEAT_ACK_TIMEOUT_MS = WEB_REMOTE_CONTROL_LIMITS.heartbeatAckTimeoutMs;
const STALE_WAITING_RECOVERY_MS = WEB_REMOTE_CONTROL_LIMITS.staleWaitingRecoveryMs;

export function createRelayTransport(options: RelayTransportOptions): RelayTransport {
  const now = options.now ?? (() => Date.now());
  let socket: WebSocket | null = null;
  let state: RelayTransportState = "idle";
  let pairStatus: RelayPairStatus = "waiting";
  let started = false;
  let deviceSid: string | undefined;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let ackWatchdogTimer: NodeJS.Timeout | null = null;
  let staleWaitingTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  function setState(next: RelayTransportState): void {
    if (state === next) return;
    state = next;
    options.events.onStateChanged(next);
  }

  function setPairStatus(next: RelayPairStatus): void {
    if (pairStatus === next) return;
    pairStatus = next;
    options.events.onPairStatusChanged(next);
    if (next === "matched") {
      options.events.onPaired();
    }
  }

  function clearTimers(): void {
    for (const timer of [heartbeatTimer, ackWatchdogTimer, staleWaitingTimer, reconnectTimer]) {
      if (timer) clearTimeout(timer);
    }
    heartbeatTimer = null;
    ackWatchdogTimer = null;
    staleWaitingTimer = null;
    reconnectTimer = null;
  }

  function sendJson(frame: unknown): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const raw = JSON.stringify(frame);
    // 物理帧硬限 1MB：超限出站拒发（附录A §1）。
    if (Buffer.byteLength(raw, "utf8") > RPC_FRAME_LIMITS.maxPhysicalFrameBytes) {
      options.logger.warn("[web-remote-relay] outbound envelope too large, refused");
      return false;
    }
    socket.send(raw);
    return true;
  }

  function sendData(payload: unknown): boolean {
    if (state !== "paired" && state !== "waiting_terminal") return false;
    return sendJson({ type: "data", payload, client_ts: now() });
  }

  function heartbeatJitterMs(): number {
    // 附录A §1：10s ± min(2s, 20%) 抖动。
    const amplitude = Math.min(RECONNECT_JITTER_MAX_MS, (HEARTBEAT_INTERVAL_MS * 20) / 100);
    return Math.round((Math.random() * 2 - 1) * amplitude);
  }

  function scheduleHeartbeat(): void {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      if (!started || !deviceSid) return;
      sendJson({ type: "pair_status_query", device_sid: deviceSid, client_ts: now() });
      armAckWatchdog();
      scheduleHeartbeat();
    }, Math.max(250, HEARTBEAT_INTERVAL_MS + heartbeatJitterMs()));
    heartbeatTimer.unref?.();
  }

  function armAckWatchdog(): void {
    if (ackWatchdogTimer) clearTimeout(ackWatchdogTimer);
    ackWatchdogTimer = setTimeout(() => {
      ackWatchdogTimer = null;
      if (!started) return;
      if (state === "waiting_terminal") {
        // stale-waiting 恢复窗 15s：未配对阶段给迟到 ack 一个恢复窗口，超时才重建链路。
        if (staleWaitingTimer) return;
        staleWaitingTimer = setTimeout(() => {
          staleWaitingTimer = null;
          options.logger.warn("[web-remote-relay] stale waiting recovery window elapsed");
          forceReconnect();
        }, STALE_WAITING_RECOVERY_MS);
        staleWaitingTimer.unref?.();
        return;
      }
      options.logger.warn("[web-remote-relay] heartbeat ack watchdog elapsed");
      forceReconnect();
    }, HEARTBEAT_ACK_TIMEOUT_MS);
    ackWatchdogTimer.unref?.();
  }

  function onHeartbeatAck(): void {
    if (staleWaitingTimer) {
      clearTimeout(staleWaitingTimer);
      staleWaitingTimer = null;
    }
    armAckWatchdog();
  }

  function reconnectDelayMs(): number {
    // 附录A §1 勘误：重连延迟为纯抖动 U[0,2s]，无 1s 基础延迟。
    return Math.floor(Math.random() * (RECONNECT_JITTER_MAX_MS + 1));
  }

  function forceReconnect(): void {
    if (!started) return;
    teardownSocket();
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (!started || reconnectTimer) return;
    setState("connecting");
    const delayMs = reconnectDelayMs();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
    reconnectTimer.unref?.();
  }

  function teardownSocket(): void {
    clearTimers();
    const current = socket;
    socket = null;
    if (!current) return;
    current.removeAllListeners();
    try {
      current.close();
    } catch {
      // socket 关闭失败不影响重建。
    }
  }

  function fatalStop(error: string): void {
    started = false;
    teardownSocket();
    setState("error");
    options.events.onError(error, true);
  }

  function handleInboundFrame(frame: RelayInboundFrame): void {
    switch (frame.type) {
      case "device_register_ack": {
        deviceSid = frame.device_sid;
        void options.persistDeviceSid(frame.device_sid).catch((error: unknown) => {
          options.logger.warn("[web-remote-relay] persist deviceSid failed", error);
        });
        setState("authenticating");
        sendJson({
          type: "auth_init",
          role: "device",
          device_sid: frame.device_sid,
          meta: options.deviceMeta(),
          client_ts: now(),
        });
        return;
      }
      case "auth_challenge": {
        void (async () => {
          const passHash = await options.resolvePassHash();
          sendJson({
            type: "auth_response",
            device_sid: deviceSid ?? "",
            proof: buildRelayAuthProof(passHash, frame.nonce, deviceSid ?? ""),
            client_ts: now(),
          });
        })().catch((error: unknown) => {
          options.logger.error("[web-remote-relay] auth proof build failed", error);
          fatalStop("relay auth proof unavailable");
        });
        return;
      }
      case "auth_ack": {
        setState(frame.pair_status === "matched" ? "paired" : "waiting_terminal");
        setPairStatus(frame.pair_status);
        if (deviceSid) options.events.onReady(deviceSid);
        scheduleHeartbeat();
        armAckWatchdog();
        return;
      }
      case "pair_status_ack": {
        onHeartbeatAck();
        setPairStatus(frame.pair_status);
        if (frame.pair_status === "waiting" && state === "paired") {
          setState("waiting_terminal");
        } else if (frame.pair_status === "matched" && state === "waiting_terminal") {
          setState("paired");
        }
        return;
      }
      case "data": {
        options.events.onData(frame.payload);
        return;
      }
      case "error": {
        if (frame.code === "KICKED") {
          started = false;
          teardownSocket();
          setState("kicked");
          options.events.onKicked(frame.message ?? "kicked");
          return;
        }
        if (frame.code === "AUTH_FAILED") {
          fatalStop(frame.message ?? "relay auth failed");
          return;
        }
        if (frame.code === "WRONG_PARAM") {
          fatalStop(frame.message ?? "relay rejected params");
          return;
        }
        options.logger.warn("[web-remote-relay] relay error", frame.code, frame.message);
        forceReconnect();
        return;
      }
    }
  }

  function onSocketMessage(data: RawData): void {
    const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBufferLike);
    // 物理帧硬限 1MB：超限入站直接丢弃（附录A §1）。
    if (raw.byteLength > RPC_FRAME_LIMITS.maxPhysicalFrameBytes) {
      options.logger.warn("[web-remote-relay] inbound envelope too large, dropped");
      return;
    }
    options.logger.debug("[web-remote-relay] inbound frame", raw.toString("utf8"));
    const frame = parseRelayInbound(raw);
    if (!frame) {
      options.logger.warn("[web-remote-relay] inbound frame parse failed, dropped");
      return;
    }
    handleInboundFrame(frame);
  }

  async function connect(): Promise<void> {
    if (!started) return;
    setState("connecting");
    let passHash: string;
    try {
      passHash = await options.resolvePassHash();
    } catch (error) {
      options.logger.error("[web-remote-relay] passHash unavailable", error);
      fatalStop("relay credentials unavailable");
      return;
    }
    if (!started) return;
    const baseUrl = options.resolveWsUrl
      ? options.resolveWsUrl()
      : resolveRelayWsUrl(process.env);
    const url = new URL(baseUrl);
    url.searchParams.set("mid", options.deviceMid);
    const next = new WebSocket(url.toString(), {
      headers: { "X-Device-ID": options.deviceMid },
      perMessageDeflate: true,
    });
    socket = next;
    next.on("open", () => {
      if (socket !== next) return;
      setState("registering");
      options.logger.debug("[web-remote-relay] socket open, registering");
      sendJson({
        type: "device_register_init",
        device_mid: options.deviceMid,
        pass_hash: passHash,
        meta: options.deviceMeta(),
        client_ts: now(),
      });
    });
    next.on("message", (data: RawData) => {
      if (socket !== next) return;
      onSocketMessage(data);
    });
    next.on("error", (error: Error) => {
      if (socket !== next) return;
      options.logger.warn("[web-remote-relay] socket error", error.message);
    });
    next.on("close", (code: number, reason: Buffer) => {
      if (socket !== next) return;
      socket = null;
      clearTimers();
      options.logger.info("[web-remote-relay] socket closed", code, reason.toString("utf8"));
      if (!started) {
        setState("idle");
        return;
      }
      options.events.onError(`relay connection closed (${code})`, false);
      scheduleReconnect();
    });
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      options.logger.info("[web-remote-relay] transport starting");
      void connect();
    },
    stop(): void {
      started = false;
      teardownSocket();
      setState("idle");
    },
    sendData,
    getState: () => state,
    getPairStatus: () => pairStatus,
    getDeviceSid: () => deviceSid,
  };
}
