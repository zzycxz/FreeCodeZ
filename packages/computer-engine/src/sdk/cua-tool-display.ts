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
  /** 本次调用参数（动作详情行来源：元素索引/按键/文本）；投影为 display.input JSON。 */
  params?: Record<string, unknown> | undefined;
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

/** P4b：引擎方法名（getAppState/leftClick/elementAtPoint）→ 渲染器动作词表
 *（get_app_state/left_click/element_at_point，cuaSummaryMessages 的 snake_case 键）。 */
function toActionWord(method: string): string {
  return method.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

/** schema cua 成员 media.data 上限（chars）；超出丢弃整条（宁缺勿超限拒收）。 */
const MAX_MEDIA_DATA_CHARS = 349_528;

/** P4b：从结果树抽离截图（screenshotPngBase64 / mimeType+data / dataUrl 三形态）
 * → media 条目，并从结构化内容副本里抹除（base64 灌 JSON 会让 display 膨胀数 MB，
 * 且重复携带已进 media 的字节）。深度限 6、只处理首个命中（一屏一图语义）。 */
function extractScreenshotFromResult(result: Record<string, unknown>): {
  scrubbed: Record<string, unknown>;
  media?: { mimeType: string; data: string };
} {
  const scrubbed = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  let found: { mimeType: string; data: string } | undefined;

  const visit = (node: unknown, depth: number): void => {
    if (found || depth > 6 || typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    const png = record.screenshotPngBase64;
    if (typeof png === "string" && png.length > 0) {
      record.screenshotPngBase64 = null;
      if (png.length <= MAX_MEDIA_DATA_CHARS) found = { mimeType: "image/png", data: png };
      return;
    }
    const mimeType = typeof record.mimeType === "string" ? record.mimeType : null;
    const data = typeof record.data === "string" ? record.data : null;
    if (mimeType?.startsWith("image/") && data && data.length > 0) {
      record.data = null;
      if (data.length <= MAX_MEDIA_DATA_CHARS) found = { mimeType, data };
      return;
    }
    if (typeof record.dataUrl === "string" && /^data:image\//u.test(record.dataUrl)) {
      const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/su.exec(record.dataUrl);
      record.dataUrl = null;
      if (match && match[2] && match[2].length <= MAX_MEDIA_DATA_CHARS) {
        found = { mimeType: match[1], data: match[2] };
      }
      return;
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };

  visit(scrubbed, 0);
  return { scrubbed, media: found };
}

export function buildCuaToolDisplay(input: CuaToolDisplayInput): CuaToolDisplay {
  const rawResult = input.result && typeof input.result === "object" && !Array.isArray(input.result)
    ? (input.result as Record<string, unknown>)
    : undefined;
  // 截图抽离：进 media、从结构化内容抹除（避免 base64 双携带）。
  const extracted = rawResult ? extractScreenshotFromResult(rawResult) : undefined;
  const result = extracted?.scrubbed;
  const extractedMedia = extracted?.media;
  // treeText 可能在顶层或 snapshot 下（getAppState 的快照结果形态）。
  const snapshotRecord =
    result && typeof result.snapshot === "object" && result.snapshot !== null
      ? (result.snapshot as Record<string, unknown>)
      : undefined;
  const treeText =
    input.text ??
    (typeof result?.treeText === "string"
      ? result.treeText
      : typeof snapshotRecord?.treeText === "string"
        ? snapshotRecord.treeText
        : result && typeof result === "object"
          ? JSON.stringify(result)
          : undefined);
  const app = input.targetApp;
  // display.input 承载动作参数 JSON（schema cua 成员 input: string——历史回放同槽）；
  // 渲染器动作详情行（元素索引/快捷键/文本）由此读取。
  let paramsJson: string | undefined;
  if (input.params && Object.keys(input.params).length > 0) {
    try {
      // 元素索引的展示兼容映射：wire 参数是 elementIndex，渲染器动作详情行读
      // target:{type:"element",index}（历史行形态）——补齐不删原键，两个形态共存。
      const displayParams: Record<string, unknown> = { ...input.params };
      if (
        typeof displayParams.elementIndex === "number" &&
        displayParams.target === undefined
      ) {
        displayParams.target = { type: "element", index: displayParams.elementIndex };
      }
      const serialized = JSON.stringify(displayParams);
      if (serialized.length <= 4_096) paramsJson = serialized;
    } catch {
      // 参数不可序列化则省略——展示字段宁缺勿错。
    }
  }
  const media = input.screenshot
    ? { mimeType: input.screenshot.mimeType, data: input.screenshot.data }
    : extractedMedia;
  return {
    kind: "cua",
    schemaVersion: 1,
    toolName: toActionWord(input.toolName),
    status: input.status,
    ...(paramsJson ? { input: paramsJson } : {}),
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
    ...(media ? { media: [media] } : {}),
  };
}
