// FreeCodeZ W-14：SDK 错误映射（附录 G.2 实施；FC 自有件）。
// orca 引擎错误码 → SDK 码 + 重试分类；possibly_sent 语义位留给 W-25 信封。

export type SdkErrorCode =
  | "ELEMENT_UNAVAILABLE"
  | "WINDOW_STALE"
  | "FOREGROUND_REQUIRED"
  | "TIMEOUT"
  | "INVALID_APP"
  | "app_blocked"
  | "permission_denied"
  | "provider_incompatible"
  | "NOT_SETTABLE"
  | "ACTION_UNAVAILABLE"
  | "INVALID_REQUEST"
  | "unsupported_capability"
  | "accessibility_error"
  | "screenshot_failed"
  | "CUA_NOT_READY"
  | "not_selectable"
  | "control_stopped"
  | "controller_busy"
  | "cancelled"
  | "user_active"
  | "actions_disabled";

export type RetryClass = "reobserve" | "never" | "retry";

export interface SdkErrorMapping {
  sdkCode: SdkErrorCode;
  retry: RetryClass;
  /** 信封 possibly_sent 语义：动作可能已送达，禁止自动重放（W-25 信封消费）。 */
  possiblySent: boolean;
}

const ENGINE_CODE_MAP: Record<string, SdkErrorMapping> = {
  element_not_found: { sdkCode: "ELEMENT_UNAVAILABLE", retry: "reobserve", possiblySent: false },
  element_not_clickable: { sdkCode: "ELEMENT_UNAVAILABLE", retry: "reobserve", possiblySent: false },
  window_not_found: { sdkCode: "WINDOW_STALE", retry: "reobserve", possiblySent: false },
  window_stale: { sdkCode: "WINDOW_STALE", retry: "reobserve", possiblySent: false },
  action_timeout: { sdkCode: "TIMEOUT", retry: "never", possiblySent: true },
  app_not_found: { sdkCode: "INVALID_APP", retry: "reobserve", possiblySent: false },
  app_blocked: { sdkCode: "app_blocked", retry: "never", possiblySent: false },
  permission_denied: { sdkCode: "permission_denied", retry: "never", possiblySent: false },
  provider_incompatible: { sdkCode: "provider_incompatible", retry: "never", possiblySent: false },
  value_not_settable: { sdkCode: "NOT_SETTABLE", retry: "never", possiblySent: false },
  action_not_supported: { sdkCode: "ACTION_UNAVAILABLE", retry: "never", possiblySent: false },
  invalid_argument: { sdkCode: "INVALID_REQUEST", retry: "never", possiblySent: false },
  unsupported_capability: { sdkCode: "unsupported_capability", retry: "retry", possiblySent: false },
  accessibility_error: { sdkCode: "accessibility_error", retry: "retry", possiblySent: false },
  screenshot_failed: { sdkCode: "screenshot_failed", retry: "retry", possiblySent: false },
};

/** 引擎不可用特征串（provider 缺失文案族）→ CUA_NOT_READY（retryable，R7 fail-closed 面）。 */
const ENGINE_UNAVAILABLE_MARKERS = [
  "has no native provider",
  "provider must be launched by FreeCodeZ",
];

export function mapEngineError(code: string | undefined, message: string): SdkErrorMapping {
  if (code === "window_not_focused") {
    // 语义分叉：含"可能已送达"按 possibly_sent（禁自动重放）；纯聚焦失败可回前台重试。
    const delivered = message.includes("may already have been delivered");
    return delivered
      ? { sdkCode: "FOREGROUND_REQUIRED", retry: "never", possiblySent: true }
      : { sdkCode: "FOREGROUND_REQUIRED", retry: "reobserve", possiblySent: false };
  }
  if (code === "unsupported_capability" && ENGINE_UNAVAILABLE_MARKERS.some((m) => message.includes(m))) {
    return { sdkCode: "CUA_NOT_READY", retry: "retry", possiblySent: false };
  }
  const mapped = code ? ENGINE_CODE_MAP[code] : undefined;
  return (
    mapped ?? { sdkCode: "INVALID_REQUEST", retry: "never", possiblySent: false }
  );
}

export class ComputerUseSdkError extends Error {
  readonly sdkCode: SdkErrorCode;
  readonly retry: RetryClass;
  readonly possiblySent: boolean;
  readonly source: string | undefined;

  constructor(mapping: SdkErrorMapping, message: string, source?: string) {
    super(message);
    this.name = "ComputerUseSdkError";
    this.sdkCode = mapping.sdkCode;
    this.retry = mapping.retry;
    this.possiblySent = mapping.possiblySent;
    this.source = source;
  }
}
