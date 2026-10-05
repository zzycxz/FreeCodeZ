// ============================================================
// 条目 3（升级实施手册）：更新检查器——GitHub Release API 优先
// ============================================================
// 设计（手册 v3.3 裁决）：
//   - 设置键 update.manifestUrl（字符串 URL）——为空 = 功能关闭（零网络零定时器）。
//     值指向 GitHub "latest release API"（https://api.github.com/repos/<owner>/<repo>/releases/latest）
//     或任意返回 { tag_name, html_url, body } 形状的 JSON 端点。
//   - main 受管定时（非裸 interval）：clearInterval + unref + dispose 全套（cuaPermissionDragPanel 先例）。
//   - fetch → semver 比较（tag 去 v 前缀）→ new Notification()（任务通知通道是 task 域专用）。
//   - 404 = 从未发过 Release → 按"无更新"处理（不报错）；断网/5xx 静默（下轮再试）；
//     production 形态才启用周期检查（dev 手动触发）。
// 纯逻辑（parseReleaseManifest/isNewerVersion/isCheckDue）与 IO 壳分离钉测试。

export interface UpdateManifestResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  releaseNotes?: string;
  fetchedAt: number;
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
  fetchJson: (url: string) => Promise<{ status: number; body?: UpdateManifestRaw }>;
  now?: () => number;
  notify: (input: { title: string; body: string; openUrl?: string; openLabel?: string }) => void;
  log?: (message: string, context?: Record<string, unknown>) => void;
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

  const checkOnce = async (): Promise<UpdateManifestResult> => {
    if (!manifestUrl?.trim()) {
      return { hasUpdate: false, currentVersion, fetchedAt: now() };
    }
    try {
      const { status, body } = await deps.fetchJson(manifestUrl);
      const result = parseReleaseManifest(status, body, currentVersion, now());
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
        status,
      });
      return result;
    } catch (error) {
      // 断网/DNS/超时：静默（下轮再试）；手动路径由调用方读返回值区分。
      deps.log?.("Update check failed (silent retry next round)", {
        event: "update.check.failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return { hasUpdate: false, currentVersion, fetchedAt: now() };
    }
  };

  let timer: NodeJS.Timeout | undefined;
  return {
    checkOnce,
    /** 受管周期（先例 cuaPermissionDragPanel：clear + unref + stop 全套）。 */
    startPeriodic(intervalMs = UPDATE_CHECK_INTERVAL_MS) {
      this.stopPeriodic();
      const first = setTimeout(() => {
        void checkOnce();
        timer = setInterval(() => void checkOnce(), intervalMs);
        timer.unref?.();
      }, UPDATE_CHECK_STARTUP_DELAY_MS);
      first.unref?.();
      timer = first as unknown as NodeJS.Timeout;
    },
    stopPeriodic() {
      if (timer) {
        clearTimeout(timer);
        clearInterval(timer as unknown as NodeJS.Timeout);
        timer = undefined;
      }
    },
  };
}
