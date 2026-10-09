// FreeCodeZ W-30：渲染器输入源投影（FC 自有件）。"13 渲染器保留概念、输入源改新
// SDK 结构化结果"的落点：工具注册层把 SDK 结果经本件投影成 display 形状——与存量
// 历史行的 kind:"cua" 归档形状同构（S6 兼容：新旧行走同一渲染链，双前缀分组同源）。
// 坐标帧/image_ref 概念按 S11 砍除：截图直接进 media（data URI 字节），新 SDK 自控
// 模型面内容量。
export interface CuaToolDisplayInput {
  toolName: string;
  status: "success" | "failed";
  /** SDK 结果对象（getAppState/leftClick/... 返回）。 */
  result?: unknown;
  /** 失败错误码（G.2 SDK 码）。 */
  errorCode?: string;
  /** 人类可读文本（treeText 等）。 */
  text?: string;
  /** 截图（PNG base64）；无截图为 undefined。 */
  screenshot?: { mimeType: string; data: string } | undefined;
  targetApp?: { displayName?: string; bundleId?: string };
}

export interface CuaToolDisplay {
  kind: "cua";
  schemaVersion: 1;
  toolName: string;
  status: "success" | "failed";
  structuredContent?: string;
  text?: string;
  errorCode?: string;
  suggestedAction?: string;
  targetApp?: {
    schemaVersion: 1;
    displayName?: string;
    iconLocators?: Array<
      | { kind: "darwin-bundle-id"; value: string }
      | { kind: "windows-executable-path"; value: string }
      | { kind: "windows-aumid"; value: string }
    >;
  };
  media?: Array<{ mimeType: string; data?: string; artifactUri?: string }>;
  truncated?: boolean;
}

/** G.2 错误码 → 恢复建议（W-15 SKILL 剧本的显示层摘要）。 */
const SUGGESTED_ACTIONS: Record<string, string> = {
  ELEMENT_UNAVAILABLE: "re-observe with get_app_state, then act on a fresh element index",
  WINDOW_STALE: "list_windows and reselect",
  FOREGROUND_REQUIRED: "bring the app forward; verify whether the action already occurred before retrying",
  TIMEOUT: "verify the effect first; do not auto-replay",
  INVALID_APP: "list_apps and reselect",
  CUA_NOT_READY: "engine not ready; retry once, then report to the user",
  user_active: "the user is actively using the mouse; retry after they go quiet",
};

export function buildCuaToolDisplay(input: CuaToolDisplayInput): CuaToolDisplay {
  const result = input.result && typeof input.result === "object"
    ? (input.result as Record<string, unknown>)
    : undefined;
  const treeText =
    input.text ??
    (typeof result?.treeText === "string"
      ? result.treeText
      : result && typeof result === "object"
        ? JSON.stringify(result)
        : undefined);
  const app = input.targetApp;
  return {
    kind: "cua",
    schemaVersion: 1,
    toolName: input.toolName,
    status: input.status,
    ...(result ? { structuredContent: JSON.stringify(result) } : {}),
    ...(treeText ? { text: treeText } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(input.errorCode && SUGGESTED_ACTIONS[input.errorCode]
      ? { suggestedAction: SUGGESTED_ACTIONS[input.errorCode] }
      : {}),
    ...(app
      ? {
          targetApp: {
            schemaVersion: 1,
            ...(app.displayName ? { displayName: app.displayName } : {}),
            ...(app.bundleId
              ? { iconLocators: [{ kind: "darwin-bundle-id" as const, value: app.bundleId }] }
              : {}),
          },
        }
      : {}),
    ...(input.screenshot
      ? { media: [{ mimeType: input.screenshot.mimeType, data: input.screenshot.data }] }
      : {}),
  };
}
