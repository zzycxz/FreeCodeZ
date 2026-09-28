// 回复管道（附录B §2.2/§2.5/§2.6）：replyMode 四档块渲染、3500 切片、工具终态行、
// 变更摘要（≤10 文件）、权限 Selection 构造、Selection 文本兜底。
// 文案走 hostMessages；排序/拒选项判定复用 @zcode/shared/bots（不重复实现）。
/* eslint-disable max-lines -- 出站渲染的纯函数全集（文本工具/工具行/变更摘要/权限/Selection），保持单文件便于与附录B §2 逐条对照。 */
import {
  getBotPermissionOptionDisplayKind,
  isRejectPermissionOption,
  sortBotPermissionOptions,
  type BotPermissionOptionKind,
  type BotSelection,
  type ReplyMode,
  type SelectionOption,
} from "@zcode/shared/bots";
import {
  formatBotMessage,
  formatStreamingMessage,
  type BotHostLocale,
  type BotHostMessageKey,
} from "./hostMessages.js";

export const REPLY_SPLIT_LIMIT = 3500;
export const TRUNCATE_LIMIT = 160;
export const TRUNCATE_MIDDLE_LIMIT = 96;
export const CHANGE_SUMMARY_MAX_FILES = 10;

export interface BotDiffStat {
  added: number;
  removed: number;
}

export interface BotChangedFileSummary extends BotDiffStat {
  path: string;
  writeCount?: number;
  lastTurnIndex?: number;
}

export interface BotChangeSummary extends BotDiffStat {
  fileCount: number;
  files: BotChangedFileSummary[];
}

export interface BotReplyToolCall {
  toolId: string;
  parentToolUseId?: string | null;
  title: string;
  toolName?: string;
  kind?: string;
  input?: unknown;
  output?: unknown;
  raw?: unknown;
  status: "pending" | "in_progress" | "completed" | "failed" | "denied" | "stopped";
  error?: string;
}

export type BotReplyPart =
  | { type: "content"; content: string }
  | { type: "thought"; content: string }
  | { type: "tool-call"; toolId: string };

export type BotReplyBlock =
  | { type: "content"; content: string }
  | { type: "tool-call"; toolCall: BotReplyToolCall }
  | { type: "change-summary"; changeSummary: BotChangeSummary };

export interface BotReplyRenderContext {
  workspacePath?: string;
  locale?: BotHostLocale;
}

// ── 文本工具（@754000 附近原文） ──

export function normalizeInlineText(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

export function truncateText(text: string, limit = TRUNCATE_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

export function truncateMiddleText(text: string, limit = TRUNCATE_MIDDLE_LIMIT): string {
  if (text.length <= limit) return text;
  const head = Math.ceil((limit - 5) * 0.65);
  const tail = Math.max(0, limit - 5 - head);
  return `${text.slice(0, head)} ... ${text.slice(text.length - tail)}`;
}

export function formatMarkdownInlineCode(value: string): string {
  return `\`${value.replace(/\\/gu, "\\\\").replace(/`/gu, "\\`")}\``;
}

export function normalizePathSeparators(value: string): string {
  return value.replace(/\\/gu, "/");
}

export function stripTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/u, "") : value;
}

/** 绝对路径 → workspace 相对路径（edit 类工具行/权限摘要用）。 */
export function toWorkspaceRelativePath(path: string, workspacePath?: string): string {
  const normalized = stripTrailingSlash(normalizePathSeparators(path.trim()));
  const base = workspacePath?.trim();
  if (!base) return normalized;
  const normalizedBase = stripTrailingSlash(normalizePathSeparators(base));
  const lower = normalized.toLowerCase();
  const baseLower = normalizedBase.toLowerCase();
  if (lower === baseLower) return ".";
  return lower.startsWith(`${baseLower}/`) ? normalized.slice(normalizedBase.length + 1) : normalized;
}

/** splitLongReplyText（wy）：limit=3500，优先在换行/空格断开。 */
export function splitLongReplyText(text: string, limit = REPLY_SPLIT_LIMIT): string[] {
  const messages: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const breakAt = Math.max(rest.lastIndexOf("\n", limit), rest.lastIndexOf(" ", limit));
    const cut = breakAt > 0 ? breakAt : limit;
    messages.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) messages.push(rest);
  return messages;
}

/** extractBotAssistantResponseMessages（MZ）：\r\n 归一；flush=false 只收 buffer。 */
export function extractBotAssistantResponseMessages(
  buffer: string,
  flush = false,
): { messages: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/gu, "\n");
  return flush
    ? { messages: splitLongReplyText(normalized), rest: "" }
    : { messages: [], rest: normalized };
}

// ── 变更摘要（qde / yy / jZ） ──

export function formatBotDiffCount(stat: BotDiffStat | undefined): string {
  const parts: string[] = [];
  if (stat && stat.added > 0) parts.push(`🟢 ${formatMarkdownInlineCode(`+${stat.added}`)}`);
  if (stat && stat.removed > 0) parts.push(`🔴 ${formatMarkdownInlineCode(`-${stat.removed}`)}`);
  return parts.join(" ");
}

/** `变更摘要：N 个文件，🟢+a 🔴-b` + 每文件 `- \`path\` (🟢+x 🔴-y)`（≤10，超出 moreFiles）。 */
export function formatBotChangeSummary(
  summary: BotChangeSummary | null | undefined,
  context?: BotReplyRenderContext,
): string {
  if (!summary || summary.fileCount <= 0 || summary.files.length === 0) return "";
  const locale = context?.locale;
  const header =
    locale === "en-US"
      ? `${formatStreamingMessage(locale, "changeSummary")}: ${summary.fileCount} files, ${formatBotDiffCount(summary)}`
      : `${formatStreamingMessage(locale, "changeSummary")}：${summary.fileCount} 个文件，${formatBotDiffCount(summary)}`;
  const lines = [header];
  for (const file of summary.files.slice(0, CHANGE_SUMMARY_MAX_FILES)) {
    lines.push(`- ${formatMarkdownInlineCode(file.path)} (${formatBotDiffCount(file)})`);
  }
  if (summary.files.length > CHANGE_SUMMARY_MAX_FILES) {
    lines.push(
      `- ${formatStreamingMessage(locale, "moreFiles", {
        count: summary.files.length - CHANGE_SUMMARY_MAX_FILES,
      })}`,
    );
  }
  return lines.join("\n");
}

// ── 工具终态行（fI / Kde / mI / $de） ──

export function formatToolStatus(
  status: BotReplyToolCall["status"],
  error: string | undefined,
  locale?: BotHostLocale,
): string {
  if (status === "completed") return formatStreamingMessage(locale, "completed");
  if (status === "failed") {
    const suffix = error ? `: ${truncateText(normalizeInlineText(error))}` : "";
    return `${formatStreamingMessage(locale, "failed")}${suffix}`;
  }
  if (status === "denied") return formatStreamingMessage(locale, "denied");
  if (status === "in_progress") return formatStreamingMessage(locale, "inProgress");
  return formatStreamingMessage(locale, "pending");
}

function buildToolPrimaryText(toolCall: BotReplyToolCall, context?: BotReplyRenderContext): string {
  const title = normalizeInlineText(toolCall.title ?? "");
  if (!title) return toolCall.toolName ?? toolCall.toolId;
  if (toolCall.kind === "edit" || toolCall.kind === "write") {
    const input = toolCall.input;
    if (typeof input === "object" && input !== null) {
      const record = input as Record<string, unknown>;
      for (const key of ["path", "file_path", "filePath"]) {
        const value = record[key];
        if (typeof value === "string" && value) {
          return `${title} ${formatMarkdownInlineCode(toWorkspaceRelativePath(value, context?.workspacePath))}`;
        }
      }
    }
  }
  return title;
}

export function formatCompactSummaryDetail(
  toolCall: BotReplyToolCall & { secondaryText?: string; changeStat?: BotDiffStat },
): string | undefined {
  const parts: string[] = [];
  if (toolCall.secondaryText) {
    parts.push(formatMarkdownInlineCode(truncateMiddleText(normalizeInlineText(toolCall.secondaryText))));
  }
  if (toolCall.changeStat) {
    const diff = formatBotDiffCount(toolCall.changeStat);
    if (diff) parts.push(diff);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** `- <状态> · <主文本>[ · <细节>]`。 */
export function formatBotToolCallSummaryLine(
  toolCall: BotReplyToolCall & { secondaryText?: string; changeStat?: BotDiffStat },
  context?: BotReplyRenderContext,
): string {
  const status = formatToolStatus(toolCall.status, toolCall.error, context?.locale);
  const primary = buildToolPrimaryText(toolCall, context);
  const detail = formatCompactSummaryDetail(toolCall);
  return `- ${status} · ${primary}${detail ? ` · ${detail}` : ""}`;
}

/** assistant_toolcalls_changes 的工具回发行：`工具调用：\n- ...`。 */
export function formatBotToolCallReply(
  toolCall: BotReplyToolCall & { secondaryText?: string; changeStat?: BotDiffStat },
  context?: BotReplyRenderContext,
): string {
  return `${formatStreamingMessage(context?.locale, "toolCalls")}\n${formatBotToolCallSummaryLine(toolCall, context)}`;
}

export function isBotToolCallReplyTerminal(status: BotReplyToolCall["status"]): boolean {
  return status === "completed" || status === "failed" || status === "denied" || status === "stopped";
}

// ── replyMode 四档（Yv createAssistantReplyBlocks） ──

interface NormalizedTurnBlocks {
  blocks: BotReplyBlock[];
  latestPart: { type: "content"; content: string } | null;
}

/** wO 简化：合并 parts（相邻 content 贯通；thought 不出站）+ toolCalls 登记。 */
export function normalizeTurnParts(
  parts: readonly BotReplyPart[],
  toolCalls: ReadonlyMap<string, BotReplyToolCall>,
): NormalizedTurnBlocks {
  const blocks: BotReplyBlock[] = [];
  let latest: { type: "content"; content: string } | null = null;
  for (const part of parts) {
    if (part.type === "thought") continue;
    if (part.type === "content") {
      const last = blocks.at(-1);
      if (last?.type === "content") {
        last.content += part.content;
        latest = { type: "content", content: last.content };
      } else {
        const block = { type: "content" as const, content: part.content };
        blocks.push(block);
        latest = { type: "content", content: block.content };
      }
      continue;
    }
    const toolCall = toolCalls.get(part.toolId);
    if (toolCall) blocks.push({ type: "tool-call", toolCall });
  }
  return { blocks, latestPart: latest };
}

/**
 * createAssistantReplyBlocks（Yv）：
 * summary_changes=仅最新 content 块；assistant_changes=全部 content；
 * assistant_toolcalls_changes=+工具块；三档完成后追加 change-summary。
 */
export function createAssistantReplyBlocks(
  parts: readonly BotReplyPart[],
  toolCalls: ReadonlyMap<string, BotReplyToolCall>,
  mode: ReplyMode | undefined,
  changeSummary: BotChangeSummary | null | undefined,
): BotReplyBlock[] {
  const granularity = mode ?? "assistant_changes";
  const normalized = normalizeTurnParts(parts, toolCalls);
  const blocks: BotReplyBlock[] = [];
  if (granularity === "summary_changes") {
    if (normalized.latestPart?.content.trim()) {
      blocks.push({ type: "content", content: normalized.latestPart.content });
    }
  } else {
    for (const block of normalized.blocks) {
      if (block.type === "content") {
        if (block.content.trim()) blocks.push(block);
        continue;
      }
      if (granularity !== "assistant_toolcalls_changes" || block.type !== "tool-call") continue;
      blocks.push(block);
    }
  }
  if (changeSummary && changeSummary.fileCount > 0 && changeSummary.files.length > 0) {
    blocks.push({ type: "change-summary", changeSummary });
  }
  return blocks;
}

/** vy：块 → 出站消息正文列表（content 切片、tool-call 单行、change-summary 文本）。 */
export function blocksToMessages(
  blocks: readonly BotReplyBlock[],
  context?: BotReplyRenderContext,
): string[] {
  const messages: string[] = [];
  for (const block of blocks) {
    if (block.type === "content") {
      messages.push(...splitLongReplyText(block.content.replace(/\r\n/gu, "\n")));
      continue;
    }
    if (block.type === "tool-call") {
      messages.push(...splitLongReplyText(formatBotToolCallReply(block.toolCall, context)));
      continue;
    }
    const summary = formatBotChangeSummary(block.changeSummary, context);
    if (summary) messages.push(...splitLongReplyText(summary));
  }
  return messages;
}

// ── 权限 Selection（§2.2） ──

export interface BotPermissionRequestLike {
  requestId: string;
  title?: string;
  description?: string;
  kind: string;
  raw?: unknown;
}

export interface BotPermissionOptionLike {
  optionId: string;
  kind: string;
  name: string;
  description?: string;
  response: unknown;
}

interface PermissionTargets {
  scope: "command" | "file" | "other";
  command?: string;
  filePaths: string[];
  fileChanges: Array<{ path: string; type?: string }>;
  title: string;
}

/** ll 简化：从 title/description/raw 提取命令与文件目标。 */
export function extractPermissionTargets(request: BotPermissionRequestLike): PermissionTargets {
  const raw = (typeof request.raw === "object" && request.raw !== null ? request.raw : {}) as Record<
    string,
    unknown
  >;
  const filePaths: string[] = [];
  const fileChanges: Array<{ path: string; type?: string }> = [];
  const collectPath = (value: unknown, type?: string): void => {
    if (typeof value === "string" && value) {
      filePaths.push(value);
      fileChanges.push(type ? { path: value, type } : { path: value });
    }
  };
  if (typeof raw.command === "string") {
    // shell 类请求以 command 为主目标
  }
  const input = (typeof raw.input === "object" && raw.input !== null ? raw.input : raw) as Record<
    string,
    unknown
  >;
  for (const key of ["path", "file_path", "filePath"]) collectPath(input[key]);
  if (Array.isArray(raw.paths)) for (const path of raw.paths) collectPath(path);
  const command = typeof raw.command === "string" ? raw.command : undefined;
  const scope: PermissionTargets["scope"] =
    filePaths.length > 0 ? "file" : command ? "command" : request.kind === "edit" ? "file" : "other";
  return {
    scope,
    ...(command ? { command } : {}),
    filePaths,
    fileChanges,
    title: request.title ?? request.description ?? request.kind,
  };
}

function formatEditPermissionKindLabel(
  request: BotPermissionRequestLike,
  targets: PermissionTargets,
  locale?: BotHostLocale,
): string {
  const haystack = [request.title, request.description, targets.title]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .trim()
    .toLowerCase();
  const changeType = targets.fileChanges[0]?.type;
  if (/\b(delete|deleted|remove|removed|erase|erased|unlink|rm)\b/u.test(haystack)) {
    return formatStreamingMessage(locale, "editDeleting");
  }
  if (
    changeType === "add" ||
    /\b(write|wrote|create|created|add|added|save|saved|new)\b/u.test(haystack)
  ) {
    return formatStreamingMessage(locale, "editWriting");
  }
  if (/\b(update|updating|updated)\b/u.test(haystack)) {
    return formatStreamingMessage(locale, "editUpdating");
  }
  return formatStreamingMessage(locale, "editEditing");
}

export function formatPermissionRequestSummary(
  request: BotPermissionRequestLike,
  context?: BotReplyRenderContext,
): string {
  const locale = context?.locale;
  const targets = extractPermissionTargets(request);
  let title = targets.title;
  if (request.kind === "edit" && (targets.scope === "file" || targets.fileChanges.length > 0)) {
    const label = formatEditPermissionKindLabel(request, targets, locale);
    const stripped = title.replace(/^edit\b[:：]?\s*/iu, "").trim();
    const suffix =
      stripped && stripped !== title
        ? targets.filePaths.length === 1 || targets.fileChanges.length === 1
          ? toWorkspaceRelativePath(
              targets.filePaths[0] ?? targets.fileChanges[0]?.path ?? "",
              context?.workspacePath,
            )
          : ""
        : "";
    title = suffix ? `${label} ${suffix}` : label;
  }
  const header = `${formatStreamingMessage(locale, "permissionRequired")}\n${title}`;
  if (targets.command) {
    return `${header}\n${formatMarkdownInlineCode(truncateMiddleText(targets.command))}`;
  }
  const paths = targets.filePaths.length > 0 ? targets.filePaths : targets.fileChanges.map((c) => c.path);
  if (paths.length > 0) {
    const joined = paths
      .slice(0, 3)
      .map((path) => formatMarkdownInlineCode(toWorkspaceRelativePath(path, context?.workspacePath)))
      .join(", ");
    return `${header}\n${truncateText(joined)}`;
  }
  return header;
}

export function formatBotPermissionOptionLabel(
  option: BotPermissionOptionLike,
  locale?: BotHostLocale,
): string {
  const kind: BotPermissionOptionKind = getBotPermissionOptionDisplayKind(
    option.optionId,
    option.kind,
    option.name,
  );
  if (kind === "custom") return option.name;
  if (locale === "en-US") {
    return (
      { allowOnce: "Allow", allowAlways: "Always Allow", rejectOnce: "Deny", rejectAlways: "Always Deny" } as const
    )[kind];
  }
  return (
    { allowOnce: "允许", allowAlways: "始终允许", rejectOnce: "拒绝", rejectAlways: "始终拒绝" } as const
  )[kind];
}

export function formatBotPermissionOptionDescription(
  option: BotPermissionOptionLike,
  request: BotPermissionRequestLike,
  locale?: BotHostLocale,
): string | undefined {
  const kind = getBotPermissionOptionDisplayKind(option.optionId, option.kind, option.name);
  if (kind === "custom") return option.kind;
  const scope = extractPermissionTargets(request).scope;
  const en = locale === "en-US";
  const persistentAllow = en
    ? scope === "command"
      ? "Do not ask again for the same command"
      : scope === "file"
        ? "Do not ask again for the same file operation"
        : "Do not ask again for the same permission request"
    : scope === "command"
      ? "后续相同命令不再询问"
      : scope === "file"
        ? "后续相同文件操作不再询问"
        : "后续相同权限请求不再询问";
  const persistentReject = en
    ? scope === "command"
      ? "Always reject the same command"
      : scope === "file"
        ? "Always reject the same file operation"
        : "Always reject the same permission request"
    : scope === "command"
      ? "后续相同命令也会直接拒绝"
      : scope === "file"
        ? "后续相同文件操作也会直接拒绝"
        : "后续相同权限请求也会直接拒绝";
  switch (kind) {
    case "allowOnce":
      return en ? "Allow this time only" : "仅允许这一次";
    case "rejectOnce":
      return en ? "Reject this time" : "这次先拒绝";
    case "allowAlways":
      return persistentAllow;
    case "rejectAlways":
      return persistentReject;
    default:
      return option.kind;
  }
}

export interface PermissionSelectionResult {
  selection: BotSelection;
  pendingOptions: Array<{
    requestId: string;
    optionId: string;
    command: "approve" | "deny";
    label: string;
    response: unknown;
  }>;
}

/** permission_request → Selection + pendingPermissionOptions（§2.2 排序/文案/permission-<id>）。 */
export function createPermissionSelection(
  request: BotPermissionRequestLike,
  options: readonly BotPermissionOptionLike[],
  context?: BotReplyRenderContext,
): PermissionSelectionResult {
  const locale = context?.locale;
  const sorted = sortBotPermissionOptions(options);
  const pendingOptions = sorted.map((option) => ({
    requestId: request.requestId,
    optionId: option.optionId,
    command: (isRejectPermissionOption(option) ? "deny" : "approve") as "approve" | "deny",
    label: formatBotPermissionOptionLabel(option, locale),
    response: option.response,
  }));
  const selection: BotSelection = {
    id: `permission-${request.requestId}`,
    title: formatPermissionRequestSummary(request, context),
    action: "permission.respond",
    showCancel: false,
    options: sorted.map((option) => ({
      id: isRejectPermissionOption(option)
        ? `/deny ${request.requestId}`
        : `/approve ${request.requestId} ${option.optionId}`,
      label: formatBotPermissionOptionLabel(option, locale),
      ...(formatBotPermissionOptionDescription(option, request, locale)
        ? { description: formatBotPermissionOptionDescription(option, request, locale) as string }
        : {}),
    })),
  };
  return { selection, pendingOptions };
}

// ── Selection 文本兜底（Ele）与当前项标记 ──

export function formatSelectionFallback(
  selection: BotSelection,
  locale?: BotHostLocale,
): string {
  const options = selection.options.map(
    (option: SelectionOption, index: number) =>
      `${index + 1}. ${option.label}${option.description ? ` ${option.description}` : ""}`,
  );
  if (selection.showCancel === false) {
    return [selection.title, ...options, "", formatBotMessage(locale, "selectionTextHintNoCancel")].join("\n");
  }
  const cancelLabel = selection.cancelLabel ?? formatBotMessage(locale, "selectionCancelOption");
  return [
    selection.title,
    `0. ${cancelLabel}`,
    ...options,
    "",
    formatBotMessage(locale, "selectionTextHint"),
  ].join("\n");
}

/** markCurrentSelection（Rn）：命中 currentId 的 label 追加 " · 当前"。 */
export function markCurrentSelection(selection: BotSelection, locale?: BotHostLocale): BotSelection {
  if (!selection.currentId) return selection;
  const marker = locale === "en-US" ? " · current" : " · 当前";
  return {
    ...selection,
    options: selection.options.map((option) =>
      option.id === selection.currentId && !option.label.includes(marker)
        ? { ...option, label: `${option.label}${marker}` }
        : option,
    ),
  };
}

/** model.provider.set 的文本 Selection 剥掉 description（xle）。 */
export function stripModelProviderDescriptionsForTextSelection(selection: BotSelection): BotSelection {
  return selection.action !== "model.provider.set"
    ? selection
    : {
        ...selection,
        options: selection.options.map((option) => ({ ...option, description: undefined })),
      };
}

// ── 状态文本零件（§2.6） ──

export function formatStatusLine(
  locale: BotHostLocale | undefined,
  key: BotHostMessageKey,
  value: string,
): string {
  return `${formatBotMessage(locale, key)}: ${value}`;
}

const DURATION_UNIT_MS = {
  second: 1000,
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
} as const;

/** formatTaskRunningDuration（VZ）：`1d 2h 3m 4s`，天/时/分/秒按需出现（全 0 时补 `0s`）。 */
export function formatTaskRunningDuration(ms: number): string {
  const total = Math.max(ms, 0);
  const days = Math.floor(total / DURATION_UNIT_MS.day);
  const hours = Math.floor((total % DURATION_UNIT_MS.day) / DURATION_UNIT_MS.hour);
  const minutes = Math.floor((total % DURATION_UNIT_MS.hour) / DURATION_UNIT_MS.minute);
  const seconds = Math.floor((total % DURATION_UNIT_MS.minute) / DURATION_UNIT_MS.second);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

export const LIVE_STATUS_PROGRESS_LIMIT = 1000;
export const STATUS_PROGRESS_DISPLAY_LIMIT = 180;

/** truncateLiveStatusProgressText（QZ）：实时进展只留末尾 1000 字符。 */
export function truncateLiveStatusProgressText(
  text: string,
  limit = LIVE_STATUS_PROGRESS_LIMIT,
): string {
  return text.length > limit ? text.slice(text.length - limit) : text;
}

export function readStatusStringField(source: unknown, keys: readonly string[]): string | null {
  if (typeof source === "string") return normalizeInlineText(source) || null;
  if (typeof source !== "object" || source === null || Array.isArray(source)) return null;
  for (const key of keys) {
    const value = (source as Record<string, unknown>)[key];
    if (typeof value === "string") {
      const normalized = normalizeInlineText(value);
      if (normalized) return normalized;
    }
  }
  return null;
}

export interface BotStreamToolProgressLike {
  title?: string;
  toolName?: string;
  kind?: string;
  status?: string;
  input?: unknown;
  output?: unknown;
  content?: unknown;
  raw?: unknown;
}

/** formatStatusStreamToolProgress（eH）：最后工具行 `标题 [状态]: 命令/路径`。 */
export function formatStatusStreamToolProgress(event: BotStreamToolProgressLike): string {
  const title = normalizeInlineText(event.title ?? event.kind ?? "tool");
  const detail =
    readStatusStringField(event.input, ["command", "path", "file_path", "filePath", "prompt"]) ??
    ("content" in event
      ? readStatusStringField(event.content, ["command", "path", "file_path", "filePath", "prompt"])
      : null) ??
    readStatusStringField(event.raw, ["command", "path", "file_path", "filePath", "prompt"]);
  const status = event.status ? ` [${event.status}]` : "";
  return detail ? `${title}${status}: ${detail}` : `${title}${status}`;
}

/** truncateStatusProgressText（vI）：快照兜底进展180 截断（177 + `...`）。 */
export function truncateStatusProgressText(
  text: string,
  limit = STATUS_PROGRESS_DISPLAY_LIMIT,
): string {
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

/** formatStatusToolProgress（qZ）：快照工具行 `标题 [状态]: 命令/路径`（title 认 toolName，detail 认 output）。 */
export function formatStatusToolProgress(tool: BotStreamToolProgressLike | null | undefined): string | null {
  if (!tool) return null;
  const title = normalizeInlineText(tool.title ?? tool.toolName ?? tool.kind ?? "tool");
  const detail =
    readStatusStringField(tool.input, ["command", "path", "file_path", "filePath", "prompt"]) ??
    readStatusStringField(tool.output, ["command", "path", "file_path", "filePath", "prompt"]) ??
    readStatusStringField(tool.raw, ["command", "path", "file_path", "filePath", "prompt"]);
  const status = tool.status ? ` [${tool.status}]` : "";
  return detail ? `${title}${status}: ${detail}` : `${title}${status}`;
}

export function formatStatusStateValue(locale: BotHostLocale | undefined, state: string): string {
  if (locale === "en-US") return state;
  switch (state) {
    case "draft":
      return formatBotMessage(locale, "statusDraft");
    case "remote disconnected":
      return formatBotMessage(locale, "statusRemoteDisconnected");
    case "running":
      return formatBotMessage(locale, "streamingStatusRunning");
    case "completed":
      return formatBotMessage(locale, "streamingStatusCompleted");
    case "error":
    case "failed":
      return formatBotMessage(locale, "streamingStatusFailed");
    case "cancelled":
      return formatBotMessage(locale, "statusCancelled");
    case "stopped":
      return formatBotMessage(locale, "statusStopped");
    default:
      return state;
  }
}
