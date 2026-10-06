// ============================================================
// 条目 3（升级实施手册）：更新检查器——GitHub Release API 优先
// ============================================================
// 设计（手册 v3.3 裁决）：
//   - 设置键 update.manifestUrl（字符串 URL）——为空 = 功能关闭（零网络零定时器）。
//     值指向 GitHub "latest release API"（https://api.github.com/repos/<owner>/<repo>/releases/latest）
//     或任意返回 { tag_name, html_url, body } 形状的 JSON 端点。
//   - main 受管定时（非裸 interval）：clearInterval + unref + dispose 全套（cuaPermissionDragPanel 先例）。
//   - fetch → semver 比较（tag 去 v 前缀）→ new Notification()（任务通知通道是 task 域专用）。
//   - 404 = 从未发过 Release → 按"无更新"处理（不报错）；断网/5xx 静默重试；
//     production 形态才启用周期检查（dev 手动触发）。
//   - 失败重试复用条目 11 限流三件套（pr-ops）：限流（Retry-After 头/文案）与 5xx/网络错
//     按退避早重试（下限 30s——三件套 2s 指数起步是给 PR 翻页的，日检器不秒级回打），
//     其余 4xx 等正常周期。周期器因此改为自适应自调度 setTimeout（受管形态不变）。
// 纯逻辑（parseReleaseManifest/isNewerVersion/planUpdateRetry）与 IO 壳分离钉测试。
import { computeBackoffMs, parseGhRateLimit, shouldRetryOnGhError, type GhRateLimitInfo } from "@zcode/shared";

export interface UpdateManifestResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  releaseNotes?: string;
  fetchedAt: number;
}

/** checkOnce 全量结果：失败时带重试计划（周期器据此自适应排程）。 */
export interface UpdateCheckResult extends UpdateManifestResult {
  failure?: UpdateRetryPlan;
}

export interface UpdateManifestRaw {
  tag_name?: unknown;
  html_url?: unknown;
  body?: unknown;
  name?: unknown;
  message?: unknown;
}

/** tag → 语义版本三元组；非法（如 "nightly-20261005"）→ undefined（不比较=无更新）。 */
export function parseVersionTag(tag: string | undefined): [number, number, number] | undefined {
  if (!tag) return undefined;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(tag.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** latest > current 才 true；任一侧解析失败 → false（保守）。 */
export function isNewerVersion(latestTag: string | undefined, currentVersion: string): boolean {
  const latest = parseVersionTag(latestTag);
  const current = parseVersionTag(currentVersion);
  if (!latest || !current) return false;
  for (let index = 0; index < 3; index += 1) {
    if ((latest[index] ?? 0) !== (current[index] ?? 0)) {
      return (latest[index] ?? 0) > (current[index] ?? 0);
    }
  }
  return false;
}

/** GitHub latest 端点响应 → 判定。404 形状（{message:"Not Found"}）与缺 tag 均为无更新。 */
export function parseReleaseManifest(
  status: number,
  body: UpdateManifestRaw | undefined,
  currentVersion: string,
  fetchedAt: number,
): UpdateManifestResult {
  const result: UpdateManifestResult = { hasUpdate: false, currentVersion, fetchedAt };
  if (status === 404 || status === 200) {
    // 200 但 message:"Not Found"（GitHub 对无 Release 仓库的代理形态）同 404 处理。
    if (typeof body?.message === "string" && body.message.includes("Not Found")) return result;
    if (typeof body?.tag_name === "string") {
      if (isNewerVersion(body.tag_name, currentVersion)) {
        result.hasUpdate = true;
        result.latestVersion = body.tag_name;
        if (typeof body.html_url === "string") result.releaseUrl = body.html_url;
        if (typeof body.body === "string") result.releaseNotes = body.body.slice(0, 2_000);
      }
    }
  }
  return result;
}

/** 周期检查间隔（保守：每日一次；GitHub 匿名限频 60/h 绰绰有余）。 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
/** 首次启动延迟（避让启动风暴）。 */
export const UPDATE_CHECK_STARTUP_DELAY_MS = 60_1_000;

export interface UpdateCheckerDeps {
  fetchJson: (url: string) => Promise<UpdateFetchOutcome>;
  now?: () => number;
  /** 退避抖动注入（测试确定性）。 */
  random?: () => number;
  notify: (input: { title: string; body: string; openUrl?: string; openLabel?: string }) => void;
  log?: (message: string, context?: Record<string, unknown>) => void;
}

/** 失败重试的下限：桌面更新器不做秒级重试。 */
export const UPDATE_RETRY_FLOOR_MS = 30_000;
/** 连续失败拍数上限（配合 computeBackoffMs 的 60s cap，封顶后恒定 30-72s 节奏）。 */
export const UPDATE_RETRY_MAX_ATTEMPT = 12;

export interface UpdateFetchOutcome {
  status: number;
  body?: UpdateManifestRaw;
  /** Retry-After 响应头（秒）——壳层提取，限流退避优先级最高。 */
  retryAfterSeconds?: number;
  /** 非 200 响应体文本（GitHub 限流文案 "retry after 60s" 在 body 里）。 */
  bodyText?: string;
}

export interface UpdateRetryPlan {
  retry: boolean;
  reason: "rate_limit" | "server" | "network" | "client_error";
  backoffMs: number;
}

/**
 * 失败重试计划（复用条目 11 限流三件套）：限流（429/Retry-After 头/body 文案）与
 * 5xx/网络错按退避早重试；其余 4xx 不早重试（等正常周期）。
 */
export function planUpdateRetry(input: {
  status?: number;
  retryAfterSeconds?: number;
  bodyText?: string;
  attempt: number;
  nowMs?: number;
  random?: () => number;
}): UpdateRetryPlan {
  const text = input.bodyText ?? "";
  const verdict = shouldRetryOnGhError({ status: input.status, text });
  if (!verdict.retry) return { retry: false, reason: verdict.reason, backoffMs: 0 };
  const parsed = parseGhRateLimit(text);
  const rateLimit: GhRateLimitInfo | undefined =
    input.retryAfterSeconds !== undefined
      ? { ...parsed, retryAfterMs: input.retryAfterSeconds * 1_000 }
      : Object.keys(parsed).length > 0
        ? parsed
        : undefined;
  const backoffMs = Math.max(
    computeBackoffMs({
      attempt: input.attempt,
      ...(rateLimit ? { rateLimit } : {}),
      ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
      ...(input.random ? { random: input.random } : {}),
    }),
    UPDATE_RETRY_FLOOR_MS,
  );
  return { retry: true, reason: verdict.reason, backoffMs };
}

/** 条目 3（升级实施手册）：默认更新源=FreeCodeZ 自有端点的 releases/latest（与 zcodeEndpoint 默认 origin 同源）。 */
export const DEFAULT_UPDATE_MANIFEST_PATH = "/releases/latest";

/** 设置键为空时回落默认源（用户显式 URL 可覆盖）。 */
export function resolveManifestUrl(explicit: string | undefined, endpointOrigin: string): string | undefined {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  const origin = endpointOrigin.trim();
  if (!origin) return undefined;
  return `${origin.replace(/\/+$/, "")}${DEFAULT_UPDATE_MANIFEST_PATH}`;
}

/**
 * 更新检查器：manifestUrl 为空 → no-op（功能关闭语义）。
 * checkOnce 供菜单手动触发与定时共用；周期模式只在显式 startPeriodic 后运行。
 */
export function createUpdateChecker(options: {
  currentVersion: string;
  manifestUrl: string | undefined;
  deps: UpdateCheckerDeps;
}) {
  const { currentVersion, manifestUrl, deps } = options;
  const now = deps.now ?? Date.now;
  let failureAttempts = 0;

  const failResult = (input: {
    status?: number;
    retryAfterSeconds?: number;
    bodyText?: string;
    error?: unknown;
  }): UpdateCheckResult => {
    failureAttempts = Math.min(failureAttempts + 1, UPDATE_RETRY_MAX_ATTEMPT);
    const plan = planUpdateRetry({
      attempt: failureAttempts,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.retryAfterSeconds !== undefined ? { retryAfterSeconds: input.retryAfterSeconds } : {}),
      ...(input.bodyText !== undefined ? { bodyText: input.bodyText } : {}),
      ...(deps.random ? { random: deps.random } : {}),
    });
    deps.log?.("Update check failed (retry scheduled per backoff)", {
      event: "update.check.failed",
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.error !== undefined
        ? { error: input.error instanceof Error ? input.error.message : String(input.error) }
        : {}),
      retryIn: plan.retry ? plan.backoffMs : "next regular interval",
      reason: plan.reason,
    });
    return { hasUpdate: false, currentVersion, fetchedAt: now(), failure: plan };
  };

  const checkOnce = async (): Promise<UpdateCheckResult> => {
    if (!manifestUrl?.trim()) {
      return { hasUpdate: false, currentVersion, fetchedAt: now() };
    }
    let outcome: UpdateFetchOutcome;
    try {
      outcome = await deps.fetchJson(manifestUrl);
    } catch (error) {
      // 断网/DNS/超时：静默退避重试；手动路径由调用方读返回值区分。
      return failResult({ error });
    }
    if (outcome.status !== 200 && outcome.status !== 404) {
      return failResult({
        status: outcome.status,
        retryAfterSeconds: outcome.retryAfterSeconds,
        bodyText: outcome.bodyText,
      });
    }
    failureAttempts = 0;
    const result = parseReleaseManifest(outcome.status, outcome.body, currentVersion, now());
    if (result.hasUpdate) {
      deps.notify({
        title: "FreeCodeZ 有新版本",
        body: `当前 ${currentVersion} → 最新 ${result.latestVersion ?? "?"}。点击查看新版。`,
        ...(result.releaseUrl ? { openUrl: result.releaseUrl, openLabel: "查看新版" } : {}),
      });
    }
    deps.log?.("Update check completed", {
      event: "update.check.completed",
      hasUpdate: result.hasUpdate,
      latestVersion: result.latestVersion,
      status: outcome.status,
    });
    return result;
  };

  let timer: NodeJS.Timeout | undefined;
  return {
    checkOnce,
    /**
     * 受管周期（先例 cuaPermissionDragPanel：clear + unref + stop 全套）。
     * 自适应自调度：失败且可重试 → 按退避计划早重试（Retry-After 优先，下限 30s）；
     * 其余（成功/无更新/不可重试错）→ 正常间隔。
     */
    startPeriodic(intervalMs = UPDATE_CHECK_INTERVAL_MS) {
      this.stopPeriodic();
      const schedule = (delayMs: number) => {
        timer = setTimeout(() => void run(), delayMs);
        timer.unref?.();
      };
      const run = async () => {
        const result = await checkOnce();
        schedule(result.failure?.retry ? result.failure.backoffMs : intervalMs);
      };
      schedule(UPDATE_CHECK_STARTUP_DELAY_MS);
    },
    stopPeriodic() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
