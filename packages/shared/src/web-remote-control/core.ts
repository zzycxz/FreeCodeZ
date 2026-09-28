import { z } from "zod";

// 移动端远控协议公共基础类型与常量（对齐官方 3.14.3 附录A §0/§3/§9）。
// 本目录为纯 schema（无 IO），Node 专用鉴权工具在 auth-node.ts 单独导出。

export const nonEmptyStringSchema = z.string().trim().min(1);
export type NonEmptyString = z.infer<typeof nonEmptyStringSchema>;

/** 序号：int ≥1（累计 ack 语义依赖严格递增）。 */
export const seqPositiveSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export type SeqPositive = z.infer<typeof seqPositiveSchema>;

export const epochMsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export type EpochMs = z.infer<typeof epochMsSchema>;

/** 传输层标识（bridgeSessionId / recoveryId 等）。 */
export const transportIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._~-]+$/u);
export type TransportId = z.infer<typeof transportIdSchema>;

export const clientModeSchema = z.enum(["desktop-continuous", "web-remote-replayable"]);
export type ClientMode = z.infer<typeof clientModeSchema>;

export const bridgeDeliveryKindSchema = z.enum(["desktop_window", "relay_bridge"]);
export type BridgeDeliveryKind = z.infer<typeof bridgeDeliveryKindSchema>;

export const deliveryPurposeSchema = z.enum(["observer", "relay_owner"]);
export type DeliveryPurpose = z.infer<typeof deliveryPurposeSchema>;

export const wireDeliveryKindSchema = z.enum(["initial", "online", "recovery"]);
export type WireDeliveryKind = z.infer<typeof wireDeliveryKindSchema>;

/** crc32 校验：8 位小写 hex。 */
export const checksumCrc32Schema = z
  .object({
    algorithm: z.literal("crc32"),
    value: z.string().regex(/^[0-9a-f]{8}$/u),
  })
  .strict();
export type ChecksumCrc32 = z.infer<typeof checksumCrc32Schema>;

/** rpc-frame 物理/逻辑上限（附录A §3.1 FRAME_LIMITS）。 */
export const RPC_FRAME_LIMITS = {
  maxPhysicalFrameBytes: 1 << 20,
  maxMessageBytes: 16 << 20,
  maxFragments: 64,
  assemblyTimeoutMs: 30_000,
  transportIdMaxChars: 256,
} as const;

/** AcknowledgedRelayProtocol 流控/重放缓冲参数（附录A §3.2，用户值 clamp 到默认值内）。 */
export const ACK_RELAY_LIMITS = {
  saturationHighWaterMarkBytes: 1 << 20,
  saturationLowWaterMarkBytes: 256 << 10,
  replayBufferMaxBytes: 8 << 20,
  replayBufferGraceMs: 45_000,
  assemblyTimeoutMs: 30_000,
} as const;

/** RelayFault 故障码全集（10 种，terminal 语义见附录A §3.2）。 */
export const RELAY_FAULT_REASONS = [
  "remote.rpcFrame.ackGraceExceeded",
  "remote.rpcFrame.replayGraceExceeded",
  "remote.rpcFrame.encodingFailed",
  "remote.rpcFrame.outerMeterFailed",
  "remote.rpcFrame.replayBufferExceeded",
  "remote.rpcFrame.sendFailed",
  "remote.rpcFrame.invalidPayload",
  "remote.rpcFrame.deliveryFailed",
  "remote.rpcFrame.futureAck",
  "remote.rpcFrame.manuallyDegraded",
] as const;
export type RelayFaultReason = (typeof RELAY_FAULT_REASONS)[number];

export const TERMINAL_RELAY_FAULT_REASONS: ReadonlySet<RelayFaultReason> = new Set([
  "remote.rpcFrame.ackGraceExceeded",
  "remote.rpcFrame.replayGraceExceeded",
  "remote.rpcFrame.replayBufferExceeded",
  "remote.rpcFrame.futureAck",
]);

export interface RelayFault {
  reasonCode: RelayFaultReason;
  terminal: boolean;
  messageSeq?: number;
}

/** workspaceKey 的唯一构造规则（AGENTS.md）：workspaceIdentity?.trim() || workspacePath。 */
export function buildWorkspaceKey(
  workspaceIdentity: string | undefined,
  workspacePath: string,
): string {
  return workspaceIdentity?.trim() || workspacePath;
}

/** 远控域常量（附录A §7 内部计时/配额）。 */
export const WEB_REMOTE_CONTROL_LIMITS = {
  heartbeatIntervalMs: 10_000,
  heartbeatAckTimeoutMs: 30_000,
  reconnectJitterMaxMs: 2_000,
  staleWaitingRecoveryMs: 15_000,
  qrReadyTimeoutMs: 30_000,
  mobileDisconnectGraceMs: 3_000,
  startAuthTokenTtlMs: 30_000,
  outboundBufferMaxEntries: 50,
  outboundBufferWindowMs: 5_000,
  rendererReconnectTimeoutMs: 120_000,
} as const;

/**
 * 端点解析：官方托管端点不可用（FreeCodeZ 无 zcode.z.ai），默认指向自建薄 relay
 * （packages/server 的 web-remote relay，本地回环），生产部署用环境变量覆盖。
 */
export const WEB_REMOTE_CONTROL_ENDPOINTS = {
  relayWsUrlEnv: "ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL",
  remotePageUrlEnv: "ZCODE_WEB_REMOTE_CONTROL_URL",
  defaultRelayWsUrl: "ws://127.0.0.1:37843/ws",
  defaultRemotePageUrl: "http://127.0.0.1:37843/remote/v4",
} as const;

export function resolveRelayWsUrl(env?: Record<string, string | undefined>): string {
  return (
    env?.[WEB_REMOTE_CONTROL_ENDPOINTS.relayWsUrlEnv] ??
    WEB_REMOTE_CONTROL_ENDPOINTS.defaultRelayWsUrl
  );
}

export function resolveRemotePageUrl(env?: Record<string, string | undefined>): string {
  return (
    env?.[WEB_REMOTE_CONTROL_ENDPOINTS.remotePageUrlEnv] ??
    WEB_REMOTE_CONTROL_ENDPOINTS.defaultRemotePageUrl
  );
}

// ---------- 内嵌 LAN relay 端点（spec §5：开箱拓扑的地址派生，纯函数便于单测） ----------

/** 默认端口与 defaultRelayWsUrl/defaultRemotePageUrl 同源（37843）。 */
export const WEB_REMOTE_CONTROL_EMBEDDED_RELAY_DEFAULT_PORT = 37843;

/** 端口候选：默认端口起顺延 count 个（EADDRINUSE 时逐个尝试）。 */
export function embeddedRelayPortCandidates(
  count = 10,
  basePort = WEB_REMOTE_CONTROL_EMBEDDED_RELAY_DEFAULT_PORT,
): number[] {
  return Array.from({ length: Math.max(1, count) }, (_, index) => basePort + index);
}

/**
 * LAN IPv4 选取：非 internal 的 IPv4 里按私网段优先级 192.168 > 172.16–31 > 10 > 其它排序，
 * 同级保持接口枚举序稳定；无候选返回 null（调用方回落 127.0.0.1，仅本机可达）。
 */
export function pickLanIPv4(
  interfaces: ReadonlyArray<ReadonlyArray<{ family: string; internal: boolean; address: string }>>,
): string | null {
  const candidates: Array<{ address: string; rank: number }> = [];
  for (const list of interfaces) {
    for (const info of list) {
      if (info.internal || info.family !== "IPv4") continue;
      candidates.push({ address: info.address, rank: rankPrivateIpv4(info.address) });
    }
  }
  if (candidates.length === 0) return null;
  // sort 稳定（ES2019+）：同级保持枚举序，多网卡时行为可预期。
  candidates.sort((left, right) => left.rank - right.rank);
  return candidates[0]?.address ?? null;
}

function rankPrivateIpv4(address: string): number {
  const first = Number.parseInt(address.split(".")[0] ?? "", 10);
  if (Number.isNaN(first)) return 9;
  if (first === 192) return 0;
  if (first === 172) {
    const second = Number.parseInt(address.split(".")[1] ?? "", 10);
    return second >= 16 && second <= 31 ? 1 : 9;
  }
  if (first === 10) return 2;
  return 9;
}

/** 内嵌 relay 双端点：桌面 transport 走回环，手机配对页走 LAN 地址。 */
export function buildEmbeddedRelayEndpoints(params: {
  port: number;
  lanHost: string;
}): { wsUrl: string; pageBaseUrl: string } {
  return {
    wsUrl: `ws://127.0.0.1:${params.port}/ws`,
    pageBaseUrl: `http://${params.lanHost}:${params.port}/remote/v4`,
  };
}
