import {
  RPC_FRAME_LIMITS,
  authAckSchema,
  pairStatusAckSchema,
  relayDataEnvelopeSchema,
  relayErrorSchema,
  relayInboundFrameSchema,
  type RelayDataEnvelope,
  type RelayErrorCode,
} from "@zcode/shared/web-remote-control";
import type { PairingEntry, PairingKick, PairingTable, RelayConn } from "./pairingTable.js";

// relay 帧校验与转发（附录A §1）：设备方向用 shared 的 relayOutbound/InboundFrameSchema，
// 手机方向单独判（mobile_hello 契约与会话在 mobilePage.ts，data/error 走 shared 子集）。
// error 帧只发本端，data 信封在配对的设备↔手机之间原样转发并盖 server_ts。
// 会话状态机按侧归属：createDeviceSession 在 webRemoteRelayServer.ts，createMobileSession 在 mobilePage.ts。

// ---------- logger / debug 计数契约（实现见 webRemoteRelayServer.ts） ----------

export type RelayLogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface RelayLogger {
  debug(message: string, detail?: Record<string, unknown>): void;
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
  error(message: string, detail?: Record<string, unknown>): void;
}

export interface RelayStats {
  oversizeFramesDropped: number;
  binaryFramesDropped: number;
  invalidFramesDropped: number;
  unpairedDeviceDataDropped: number;
  unpairedMobileDataDropped: number;
  forwardedData: number;
}

/** 应用层断开码（WS 4xxx 段）：报文先发 error 帧再按此码 close。 */
export const RELAY_CLOSE_CODES = {
  KICKED: 4001,
  AUTH_FAILED: 4002,
  WRONG_PARAM: 4003,
  INTERNAL: 4004,
} as const;

// ---------- 手机方向帧判定（与设备方向分开判） ----------

/** relay→手机可用帧：hello 应答(auth_ack)、配对状态推送(pair_status_ack)、data、error。 */
export function isRelayToMobileFrame(value: unknown): boolean {
  return (
    authAckSchema.safeParse(value).success ||
    pairStatusAckSchema.safeParse(value).success ||
    relayDataEnvelopeSchema.safeParse(value).success ||
    relayErrorSchema.safeParse(value).success
  );
}

// ---------- 发送 / 踢出 / 失败 ----------

function writeFrame(conn: RelayConn, frame: unknown, logger: RelayLogger): boolean {
  const text = JSON.stringify(frame);
  if (Buffer.byteLength(text, "utf8") > RPC_FRAME_LIMITS.maxPhysicalFrameBytes) {
    logger.warn("出站物理帧超 1MB，已丢弃", { connId: conn.connId });
    return false;
  }
  return conn.sendText(text);
}

/** relay→device 帧用 relayInboundFrameSchema 校验后发送。 */
export function sendToDevice(conn: RelayConn, frame: unknown, logger: RelayLogger): boolean {
  if (!relayInboundFrameSchema.safeParse(frame).success) {
    logger.error("relay→device 帧校验失败", { connId: conn.connId });
    return false;
  }
  return writeFrame(conn, frame, logger);
}

/** relay→mobile 帧用手机方向子集校验后发送。 */
export function sendToMobile(conn: RelayConn, frame: unknown, logger: RelayLogger): boolean {
  if (!isRelayToMobileFrame(frame)) {
    logger.error("relay→mobile 帧校验失败", { connId: conn.connId });
    return false;
  }
  return writeFrame(conn, frame, logger);
}

function sendRelayError(
  conn: RelayConn,
  code: RelayErrorCode,
  message: string,
  logger: RelayLogger,
): void {
  const frame = { type: "error" as const, code, message };
  if (conn.role === "device") {
    sendToDevice(conn, frame, logger);
  } else {
    sendToMobile(conn, frame, logger);
  }
}

function kickReasonMessage(reason: PairingKick["reason"]): string {
  switch (reason) {
    case "device-replaced":
      return "kicked: another device connection took over";
    case "mobile-replaced":
      return "kicked: another mobile page took over";
    case "pass-hash-rotated":
      return "kicked: pairing credentials rotated";
  }
}

/** KICKED 只发被替换端本端并断开，不向对端转发（对齐「第二页面触发踢出」）。 */
export function applyKicks(kicks: readonly PairingKick[], logger: RelayLogger): void {
  for (const kick of kicks) {
    logger.info("kicked connection", {
      connId: kick.conn.connId,
      role: kick.conn.role,
      reason: kick.reason,
    });
    sendRelayError(kick.conn, "KICKED", kickReasonMessage(kick.reason), logger);
    kick.conn.close(RELAY_CLOSE_CODES.KICKED, "KICKED");
  }
}

/** 配对状态迁移推送（FreeCodeZ 扩展：让设备/手机不等心跳即可感知 matched/waiting）。 */
export function pushPairStatus(entry: PairingEntry, logger: RelayLogger): void {
  if (entry.deviceConn) {
    sendToDevice(
      entry.deviceConn,
      { type: "pair_status_ack", pair_status: entry.pairStatus },
      logger,
    );
  }
  if (entry.mobileConn) {
    sendToMobile(
      entry.mobileConn,
      { type: "pair_status_ack", pair_status: entry.pairStatus },
      logger,
    );
  }
}

/** 握手参数非法/鉴权失败时的统一拒绝：error 帧只发本端并断开。 */
export function rejectConnection(
  conn: RelayConn,
  code: RelayErrorCode,
  message: string,
  logger: RelayLogger,
): void {
  sendRelayError(conn, code, message, logger);
  conn.close(RELAY_CLOSE_CODES[code], code);
}

// ---------- 会话公共骨架 ----------

export interface RelaySessionDeps {
  table: PairingTable;
  logger: RelayLogger;
  stats: RelayStats;
}

export interface RelaySession {
  readonly role: "device" | "mobile";
  handleMessage(data: unknown): void;
  dispose(): void;
}

export type ParsedText =
  | { ok: true; value: unknown }
  | { ok: false; reason: "oversize" | "bad-json" };

/** 入站文本帧：物理帧硬限 1MB（超限丢弃、连接保留），再做 JSON 解析。 */
export function parseTextFrame(text: string, conn: RelayConn, deps: RelaySessionDeps): ParsedText {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > RPC_FRAME_LIMITS.maxPhysicalFrameBytes) {
    deps.stats.oversizeFramesDropped += 1;
    deps.logger.debug("物理帧超 1MB 丢弃", { connId: conn.connId, bytes });
    return { ok: false, reason: "oversize" };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "bad-json" };
  }
}

/** 会话公共外壳：JSON 文本帧判定、二进制丢弃计数、断开时从配对表摘除。 */
export function toSession(
  conn: RelayConn,
  deps: RelaySessionDeps,
  closed: () => boolean,
  handleText: (text: string) => void,
): RelaySession {
  return {
    role: conn.role,
    handleMessage(data: unknown): void {
      if (closed()) return;
      if (typeof data !== "string") {
        deps.stats.binaryFramesDropped += 1;
        deps.logger.debug("二进制帧丢弃（协议为 JSON 文本帧）", { connId: conn.connId });
        return;
      }
      handleText(data);
    },
    dispose(): void {
      const result = deps.table.detach(conn);
      if (result?.mobileDisconnected) {
        deps.logger.info("mobile disconnected", { connId: conn.connId });
        pushPairStatus(result.entry, deps.logger);
      }
      // 设备断开而手机仍在：向手机推 pair_status_ack{waiting} 作为「配对不完整」信号，
      // 手机据此渲染断线横幅并等待桌面重连（entry.pairStatus 本身是设备视角的手机在位状态，不变）。
      if (result && conn.role === "device" && !result.entry.deviceConn && result.entry.mobileConn) {
        deps.logger.info("device disconnected with mobile attached", { connId: conn.connId });
        sendToMobile(
          result.entry.mobileConn,
          { type: "pair_status_ack", pair_status: "waiting" },
          deps.logger,
        );
      }
    },
  };
}

/** data 信封转发：配对对端原样转发并盖 server_ts；未配对丢弃并计 debug 数。 */
export function forwardData(
  from: RelayConn,
  frame: RelayDataEnvelope,
  deps: RelaySessionDeps,
): void {
  const entry = deps.table.entryOf(from);
  const target = from.role === "device" ? entry?.mobileConn : entry?.deviceConn;
  if (!entry || !target) {
    if (from.role === "device") {
      deps.stats.unpairedDeviceDataDropped += 1;
    } else {
      deps.stats.unpairedMobileDataDropped += 1;
    }
    deps.logger.debug("未配对 data 丢弃", { connId: from.connId, from: from.role });
    return;
  }
  const forwarded: RelayDataEnvelope = {
    type: "data",
    payload: frame.payload,
    ...(frame.client_ts !== undefined ? { client_ts: frame.client_ts } : {}),
    server_ts: Date.now(),
  };
  const sent =
    target.role === "device"
      ? sendToDevice(target, forwarded, deps.logger)
      : sendToMobile(target, forwarded, deps.logger);
  if (sent) deps.stats.forwardedData += 1;
}
