// ============================================================
// 条目 11（升级实施手册）：PR 双层工具集基建三件（零存量新建）
// ============================================================
// 语义：
//   ① 结构化分页（nextOffset 对齐 read-text.ts 的续读语义）：PR diff 超大时按
//      文件段落分页，offset=文件序偏移；
//   ② 乐观并发 expectedHeadRevision：审查期间推新提交被拦——PR 创建/更新前
//      校验 head sha 与观察时一致；
//   ③ 限流三件套（gh 零存量新建）：gh 限流响应解析 / 退避计算（含 Retry-After
//      优先）/ 是否可重试判定。
// 纯函数；工具层（bash-gh 白名单族）与未来 PR 专用工具共用。

export interface PrDiffPage {
  content: string;
  /** 下一页 offset（= 已输出的文件数）；无更多=undefined。 */
  nextOffset?: number;
  totalFiles: number;
  truncated: boolean;
  shown: number;
}

/** 切出 PR diff 的文件段（以 `diff --git` 行为界）。 */
export function splitPrDiffFiles(diffText: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join("\n"));
  return sections.filter((section) => section.trim().length > 0);
}

/**
 * PR diff 分页：offset=文件序（0 起）；limit=本页文件数（缺省 10）。
 * nextOffset 对齐 read-text：endLine+1 的续读语义（文件序的下一段）。
 */
export function paginatePrDiff(
  diffText: string,
  options: { offset?: number; limit?: number } = {},
): PrDiffPage {
  const files = splitPrDiffFiles(diffText);
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.max(1, Math.floor(options.limit ?? 10));
  const page = files.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    content: page.join("\n"),
    ...(nextOffset < files.length ? { nextOffset } : {}),
    totalFiles: files.length,
    truncated: nextOffset < files.length,
    shown: page.length,
  };
}

export type HeadRevisionCheck =
  | { ok: true }
  | { ok: false; code: "stale_head"; message: string };

/**
 * 乐观并发（expectedHeadRevision）：current=当前 head sha（gh pr view --json headRefOid），
 * expected=审查时观察的 sha。不一致 → stale_head（结构化拒绝，不盲写）。
 */
export function verifyExpectedHeadRevision(
  currentHeadSha: string | undefined,
  expectedHeadSha: string | undefined,
): HeadRevisionCheck {
  if (!expectedHeadSha) return { ok: true }; // 未声明期望=不做并发约束（现状语义）
  if (!currentHeadSha) {
    return { ok: false, code: "stale_head", message: "cannot read current head sha; refusing blind write" };
  }
  if (currentHeadSha === expectedHeadSha) return { ok: true };
  return {
    ok: false,
    code: "stale_head",
    message: `head moved since you read the PR (expected ${expectedHeadSha.slice(0, 12)}, current ${currentHeadSha.slice(0, 12)}); re-read and retry`,
  };
}

export interface GhRateLimitInfo {
  remaining?: number;
  resetAtMs?: number;
  retryAfterMs?: number;
}

/**
 * 限流解析三件套①：gh stderr/响应文本 → 限流事实。
 * 形态：gh stderr "API rate limit exceeded ... reset at <ISO>" / "Retry-After: N" /
 * "You have exceeded a secondary rate limit ... retry after Ns"。
 */
export function parseGhRateLimit(text: string): GhRateLimitInfo {
  const info: GhRateLimitInfo = {};
  const retryAfterSeconds = /retry after\s+(\d+)\s*s/iu.exec(text);
  const retryAfterHeader = /retry-after[:\s]+(\d+)/iu.exec(text);
  const seconds = retryAfterSeconds?.[1] ?? retryAfterHeader?.[1];
  if (seconds) info.retryAfterMs = Number(seconds) * 1_000;
  const resetAt = /reset at\s+([^\s.,;)]+)/iu.exec(text);
  if (resetAt?.[1]) {
    const parsed = Date.parse(resetAt[1]);
    if (Number.isFinite(parsed)) info.resetAtMs = parsed;
  }
  const remaining = /remaining[:\s]+(\d+)/iu.exec(text);
  if (remaining?.[1]) info.remaining = Number(remaining[1]);
  return info;
}

/**
 * 限流三件套②：退避计算。Retry-After（resetAtMs/retryAfterMs）优先；缺省指数退避
 * （base 2s，attempt 1 起，cap 60s）+ 20% jitter 防羊群。
 */
export function computeBackoffMs(input: {
  attempt: number;
  rateLimit?: GhRateLimitInfo;
  nowMs?: number;
  random?: () => number;
}): number {
  const now = input.nowMs ?? Date.now();
  const random = input.random ?? Math.random;
  const remainingMs =
    input.rateLimit?.retryAfterMs ??
    (input.rateLimit?.resetAtMs !== undefined ? Math.max(0, input.rateLimit.resetAtMs - now) : undefined);
  if (remainingMs !== undefined && remainingMs > 0) {
    return Math.min(remainingMs, 60 * 60 * 1_000); // 尊重服务端上限 1h
  }
  const attempt = Math.max(1, Math.floor(input.attempt));
  const base = Math.min(2_000 * 2 ** (attempt - 1), 60_000);
  const jitter = base * 0.2 * random();
  return Math.round(base + jitter);
}

/**
 * 限流三件套③：是否可重试。限流类（primary 403/429 + secondary）一律可重试；
 * 其余 4xx 不可重试（请求本身错），5xx/network 可重试。
 */
export function shouldRetryOnGhError(input: {
  status?: number;
  text?: string;
}): { retry: boolean; reason: "rate_limit" | "server" | "network" | "client_error" } {
  const text = input.text ?? "";
  const isRateLimited =
    /rate limit exceeded|secondary rate limit|retry after/iu.test(text) || input.status === 429;
  if (isRateLimited) return { retry: true, reason: "rate_limit" };
  if (input.status !== undefined && input.status >= 500) return { retry: true, reason: "server" };
  if (input.status === undefined) return { retry: true, reason: "network" };
  return { retry: false, reason: "client_error" };
}
