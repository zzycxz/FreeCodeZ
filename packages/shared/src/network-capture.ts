import { z } from "zod";

// ============================================================
// U2-6（移植自 ZCode 3.15.1 资源管理器「网络」标签页，上游 main NetworkCaptureBuffer
// @467760 + chunk-KL4L7SET 协议 schema@503100 + CLI createNodeNetworkCapture@507704；
// 脱敏函数上游为四处副本，FC 收敛为本模块单点）
// ============================================================
// 语义：window-scoped——资源管理器窗口打开期间记录本机应用出网请求，环形缓冲
// 1,000 条（超出按序淘汰并计数）；「清空」=captureId 全局轮换；关窗即停并清零。
// 记录只有请求方向元数据（无状态码/字节数）；URL 在每个进程边界统一脱敏。

export const NETWORK_CAPTURE_BUFFER_LIMIT = 1_000;
export const NETWORK_CAPTURE_URL_MAX_LENGTH = 2_048;

export const networkCaptureProcessTypeSchema = z.enum(["main", "host", "renderer", "cli"]);
export type NetworkCaptureProcessType = z.infer<typeof networkCaptureProcessTypeSchema>;

export const networkCaptureRecordSchema = z
  .object({
    /** main 环形缓冲入列时自增（UI 排序 tiebreaker）。 */
    id: z.number().int().nonnegative(),
    timestamp: z.number().int().nonnegative(),
    processType: networkCaptureProcessTypeSchema,
    pid: z.number().int().nonnegative(),
    method: z.string().min(1).max(32),
    url: z.string().max(NETWORK_CAPTURE_URL_MAX_LENGTH),
  })
  .strict();
export type NetworkCaptureRecord = z.infer<typeof networkCaptureRecordSchema>;

export const networkCaptureBatchSchema = z
  .object({
    captureId: z.string().min(1).max(100),
    records: z.array(networkCaptureRecordSchema.omit({ id: true })).max(100),
    dropped: z.number().int().nonnegative(),
  })
  .strict();
export type NetworkCaptureBatch = z.infer<typeof networkCaptureBatchSchema>;

export const networkCaptureSnapshotSchema = z
  .object({
    captureId: z.string().min(1),
    records: z.array(networkCaptureRecordSchema),
    dropped: z.number().int().nonnegative(),
  })
  .strict();
export type NetworkCaptureSnapshot = z.infer<typeof networkCaptureSnapshotSchema>;

/** main↔host 端口消息（上游 network-capture / network-capture-batch 同名同形）。 */
export const HOST_MESSAGE_NETWORK_CAPTURE = "network-capture";
export const HOST_RESPONSE_NETWORK_CAPTURE_BATCH = "network-capture-batch";

/**
 * 脱敏（上游 sanitizeNetworkCaptureUrl，四处副本收敛的单点）：非 http(s)/ws(s) 丢弃、
 * userinfo 凭据删除、hash 删除、query 值全 [redacted]（键保留）、2048 截断。
 * 残余面：路径与主机名原样保留（上游同）。
 */
export function sanitizeNetworkCaptureUrl(rawUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return undefined;
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  // 快照迭代：set() 作用于活跃视图，遍历中原地改需要拷贝（no-useless-spread 在此误报）。
  // oxlint-disable-next-line unicorn(no-useless-spread)
  for (const key of [...parsed.searchParams.keys()]) {
    parsed.searchParams.set(key, "[redacted]");
  }
  return parsed.href.slice(0, NETWORK_CAPTURE_URL_MAX_LENGTH) || undefined;
}
