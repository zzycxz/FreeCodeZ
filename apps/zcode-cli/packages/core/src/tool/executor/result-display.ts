import {
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  RespondToCoordinatorOutputSchema,
  MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS,
  MCP_TOOL_DISPLAY_MAX_NAME_CHARS,
  SEND_MESSAGE_TOOL_NAME,
  SendMessageOutputSchema,
  TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS,
  TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS,
  TASK_OUTPUT_TOOL_NAME,
  TaskOutputResultSchema,
  TASK_STOP_TOOL_NAME,
  TaskStopOutputSchema,
  type DiffHunk,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";
import { createBashResultDisplay } from "./bash-result-display.js";
import { countPatchLines } from "../diff.js";
import { boundDisplayText } from "./display-text.js";
import { createCreateWorkflowDisplay } from "./create-workflow-display.js";
import { createWorkflowObservationDisplay } from "./workflow-observation-display.js";

// 拆到 create-workflow-display.ts 后保持既有导出面（handlers/create-workflow.ts 仍从这里 import）。
export { createCreateWorkflowDisplay } from "./create-workflow-display.js";
import { isRecord } from "./utils.js";

const MAX_DISPLAY_DIFF_HUNKS = 8;
const MAX_DISPLAY_DIFF_LINES = 160;
const MAX_SEND_MESSAGE_DISPLAY_FIELD_BYTES = 4 * 1024;
const MAX_TASK_STOP_DISPLAY_FIELD_BYTES = 16 * 1024;
export const MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES = 200 * 1024;
const MAX_NODE_REPL_DISPLAY_IMAGES = 2;

export function createMcpToolDisplay(
  metadata:
    | {
        serverName: string;
        toolName: string;
        description?: string;
      }
    | undefined,
  output?: unknown,
): ToolResultDisplayPayload | undefined {
  if (!metadata) return undefined;
  const serverName = boundMcpDisplayText(metadata.serverName, MCP_TOOL_DISPLAY_MAX_NAME_CHARS);
  const toolName = boundMcpDisplayText(metadata.toolName, MCP_TOOL_DISPLAY_MAX_NAME_CHARS);
  if (!serverName || !toolName) return undefined;
  const description = metadata.description
    ? boundMcpDisplayText(metadata.description, MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS)
    : undefined;
  return {
    kind: "mcp_tool",
    serverName,
    toolName,
    ...(description ? { description } : {}),
  };
}


export function createToolResultDisplay(
  toolName: string,
  output: unknown,
  options?: {
    mcp?: {
      serverName: string;
      toolName: string;
      description?: string;
      official?: boolean;
    };
  },
): ToolResultDisplayPayload | undefined {
  if (toolName === "Bash") return createBashResultDisplay(output);

  const nodeReplDisplay = createNodeReplDisplay(toolName, output);
  if (nodeReplDisplay) return nodeReplDisplay;

  const createWorkflow = createCreateWorkflowDisplay(toolName, output);
  if (createWorkflow) return createWorkflow;

  const workflowObservation = createWorkflowObservationDisplay(toolName, output);
  if (workflowObservation) return workflowObservation;

  if (options?.mcp) {
    // 结果级构造：官方 MCP 的不可用标识只能从本次结果里读，因此把 output 一起传进去。
    return createMcpToolDisplay(options.mcp, output);
  }

  if (toolName === SEND_MESSAGE_TOOL_NAME) {
    const parsed = SendMessageOutputSchema.safeParse(output);
    if (!parsed.success) return undefined;
    // display 不经过 tool result budget，必须在进入实时事件和持久化 metadata 前单独限长。
    const error =
      parsed.data.error === undefined
        ? undefined
        : boundDisplayText(parsed.data.error, MAX_SEND_MESSAGE_DISPLAY_FIELD_BYTES).value;
    const message =
      parsed.data.message === undefined
        ? undefined
        : boundDisplayText(parsed.data.message, MAX_SEND_MESSAGE_DISPLAY_FIELD_BYTES).value;
    return {
      kind: "local_agent_message",
      status: parsed.data.status,
      ...(error !== undefined ? { error } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  }

  if (toolName === TASK_STOP_TOOL_NAME) {
    const parsed = TaskStopOutputSchema.safeParse(output);
    if (!parsed.success) return undefined;
    const command =
      parsed.data.command === undefined
        ? undefined
        : boundDisplayText(parsed.data.command, MAX_TASK_STOP_DISPLAY_FIELD_BYTES);
    const message = boundDisplayText(
      compactTaskStopDisplayMessage(parsed.data),
      MAX_TASK_STOP_DISPLAY_FIELD_BYTES,
    );
    const truncated = command?.truncated === true || message.truncated;
    return {
      kind: "task_stop",
      taskId: parsed.data.task_id,
      taskType: parsed.data.task_type,
      ...(command !== undefined ? { command: command.value } : {}),
      message: message.value,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  if (toolName === TASK_OUTPUT_TOOL_NAME) {
    const parsed = TaskOutputResultSchema.safeParse(output);
    if (!parsed.success) return undefined;
    const taskStatus = parsed.data.task?.status
      .trim()
      .slice(0, TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS);
    const fullOutput = parsed.data.task?.output.trimEnd();
    const hasOutput = fullOutput !== undefined && fullOutput.trim().length > 0;
    const truncated = hasOutput && fullOutput.length > TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS;

    // UI display 是独立于 provider content 的有界投影；禁止把完整 TaskOutput XML
    // 或结果对象塞进实时事件和持久化 metadata。
    return {
      kind: "task_output",
      retrievalStatus: parsed.data.retrieval_status,
      ...(taskStatus ? { taskStatus } : {}),
      ...(hasOutput ? { output: fullOutput.slice(0, TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS) } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  }

  if (toolName === RESPOND_TO_COORDINATOR_TOOL_NAME) {
    const parsed = RespondToCoordinatorOutputSchema.safeParse(output);
    if (!parsed.success) return undefined;
    return {
      kind: "respond_to_coordinator",
      status: parsed.data.status,
    };
  }

  if (!isRecord(output)) return undefined;
  const filePath = output.filePath;
  const structuredPatch = output.structuredPatch;
  if (typeof filePath !== "string" || !Array.isArray(structuredPatch)) {
    return undefined;
  }

  const hunks = structuredPatch.filter(isDiffHunk);
  if (hunks.length === 0) return undefined;

  const { additions, deletions } = countPatchLines(hunks);
  const { patch: boundedPatch, truncated } = boundDiffHunks(hunks);
  return {
    kind: "file_diff",
    filePath,
    additions,
    deletions,
    structuredPatch: boundedPatch,
    truncated,
  };
}

function boundMcpDisplayText(value: string, maxChars: number): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const bounded = trimmed.slice(0, maxChars);
  // MCP discovery 是外部输入，直接 slice 可能在 UTF-16 surrogate pair
  // 中间截断，生成无法稳定跨事件、持久化和 replayable snapshot 的字符串。
  // 若边界落在高位 surrogate 后，丢弃这个半字符，保证 display 始终可安全序列化。
  const lastCodeUnit = bounded.charCodeAt(bounded.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? bounded.slice(0, -1) : bounded;
}


function collectNodeReplImages(output: Record<string, unknown>): {
  images: Array<{ base64: string; mimeType: string }>;
  truncated: boolean;
} {
  const candidates = [
    ...(Array.isArray(output.images) ? output.images : []),
    ...(Array.isArray(output.content) ? output.content : []),
  ];
  const images: Array<{ base64: string; mimeType: string }> = [];
  let truncated = false;

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const mimeType = candidate.mimeType;
    const encoded = candidate.base64 ?? candidate.data;
    if (
      typeof mimeType !== "string" ||
      !/^image\/[a-z0-9.+-]+$/iu.test(mimeType) ||
      typeof encoded !== "string"
    ) {
      continue;
    }
    const base64 = encoded.startsWith("data:")
      ? encoded.slice(Math.max(0, encoded.indexOf(",") + 1))
      : encoded;
    if (
      base64.length === 0 ||
      Buffer.byteLength(base64, "utf8") > MAX_NODE_REPL_DISPLAY_IMAGE_BASE64_BYTES
    ) {
      truncated = true;
      continue;
    }
    if (images.length >= MAX_NODE_REPL_DISPLAY_IMAGES) {
      truncated = true;
      continue;
    }
    images.push({ base64, mimeType });
  }
  return { images, truncated };
}

/** P4b CUA display 字段限界（display 不经 tool result budget，入流前单独限长）。 */
const MAX_CUA_DISPLAY_FIELD_CHARS = 16 * 1024;
const MAX_CUA_DISPLAY_MEDIA_ENTRIES = 4;
const MAX_CUA_DISPLAY_MEDIA_DATA_CHARS = 349_528;

function boundCuaDisplayString(value: unknown, cap: number): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.length <= cap
      ? value
      : value.slice(0, cap)
    : undefined;
}

/** 读取桥下行的 CUA 操作投影（freecodez/nodeReplCuaDisplay）。只收
 * kind:"cua"+schemaVersion:1 的完整形状；缺件/越界字段裁剪，媒体条目限 4、
 * 单条限 349528（schema 口径）。误收防护：其余 kind 一律拒绝（走图片/无 display 路径）。 */
function readCuaDisplayMeta(output: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta = output.responseMeta;
  if (!isRecord(meta)) return undefined;
  const display = meta["freecodez/nodeReplCuaDisplay"];
  if (!isRecord(display)) return undefined;
  if (display.kind !== "cua" || display.schemaVersion !== 1) return undefined;
  if (typeof display.toolName !== "string" || display.toolName.length === 0) return undefined;
  if (display.status !== "success" && display.status !== "failed") return undefined;

  const media: Array<{ mimeType: string; data?: string; artifactUri?: string }> = [];
  if (Array.isArray(display.media)) {
    for (const entry of display.media.slice(0, MAX_CUA_DISPLAY_MEDIA_ENTRIES)) {
      if (!isRecord(entry)) continue;
      const mimeType = entry.mimeType;
      if (typeof mimeType !== "string" || mimeType.length === 0) continue;
      const data = entry.data;
      if (typeof data === "string") {
        if (data.length > 0 && data.length <= MAX_CUA_DISPLAY_MEDIA_DATA_CHARS) {
          media.push({ mimeType, data });
        }
        continue;
      }
      if (typeof entry.artifactUri === "string") {
        media.push({ mimeType, artifactUri: entry.artifactUri });
      }
    }
  }
  return {
    kind: "cua",
    schemaVersion: 1,
    toolName: display.toolName.slice(0, 256),
    status: display.status,
    ...(boundCuaDisplayString(display.input, MAX_CUA_DISPLAY_FIELD_CHARS)
      ? { input: boundCuaDisplayString(display.input, MAX_CUA_DISPLAY_FIELD_CHARS) }
      : {}),
    ...(boundCuaDisplayString(display.structuredContent, MAX_CUA_DISPLAY_FIELD_CHARS)
      ? { structuredContent: boundCuaDisplayString(display.structuredContent, MAX_CUA_DISPLAY_FIELD_CHARS) }
      : {}),
    ...(boundCuaDisplayString(display.text, MAX_CUA_DISPLAY_FIELD_CHARS)
      ? { text: boundCuaDisplayString(display.text, MAX_CUA_DISPLAY_FIELD_CHARS) }
      : {}),
    ...(boundCuaDisplayString(display.errorCode, 512) ? { errorCode: boundCuaDisplayString(display.errorCode, 512) } : {}),
    ...(boundCuaDisplayString(display.suggestedAction, 1024)
      ? { suggestedAction: boundCuaDisplayString(display.suggestedAction, 1024) }
      : {}),
    ...(isRecord(display.targetApp) ? { targetApp: display.targetApp } : {}),
    ...(media.length > 0 ? { media } : {}),
  };
}

/** 混合 run（CUA 操作 + 浏览器截图）：浏览器图片并入 cua display 的 media
 *（schema 允许 4 条），丢弃会让纯浏览器截图段失渲染。 */
function appendImagesToCuaDisplay(
  cuaDisplay: Record<string, unknown>,
  extra: { images: Array<{ base64: string; mimeType: string }>; truncated: boolean },
): ToolResultDisplayPayload {
  const existing = Array.isArray(cuaDisplay.media) ? cuaDisplay.media : [];
  const room = MAX_CUA_DISPLAY_MEDIA_ENTRIES - existing.length;
  const appended = extra.images.slice(0, Math.max(room, 0)).map((image) => ({
    mimeType: image.mimeType,
    data: image.base64,
  }));
  const merged = [...existing, ...appended];
  return {
    ...(cuaDisplay as unknown as ToolResultDisplayPayload),
    ...(merged.length > 0 ? { media: merged } : {}),
    ...(extra.truncated && appended.length < extra.images.length ? { truncated: true } : {}),
  } as ToolResultDisplayPayload;
}

function createNodeReplDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== "js" && toolName !== "mcp__node_repl__js") return undefined;
  if (!isRecord(output)) return undefined;

  // P4b（display 复产）：桥经 freecodez/nodeReplCuaDisplay 下行的操作投影
  //（computer-bridge onCuaOperation → buildCuaToolDisplay）。校验 kind 防误收，
  // 字段限界与 node_repl_images 同口径（display 不经 tool result budget）。
  const cuaDisplay = readCuaDisplayMeta(output);
  if (cuaDisplay) {
    return appendImagesToCuaDisplay(cuaDisplay, collectNodeReplImages(output));
  }

  const { images, truncated } = collectNodeReplImages(output);
  if (images.length === 0) return undefined;
  return {
    kind: "node_repl_images",
    images,
    ...(truncated ? { truncated: true } : {}),
  };
}

function compactTaskStopDisplayMessage(output: {
  command?: string;
  message: string;
  task_id: string;
}): string {
  if (output.command === undefined) {
    return output.message;
  }

  // TaskStop 的标准成功文案会把 command 再拼进括号；display 已有
  // 独立 command 字段，结果行只保留停止结论。
  const standardMessage = `Successfully stopped task: ${output.task_id} (${output.command})`;
  return output.message === standardMessage
    ? `Successfully stopped task: ${output.task_id}`
    : output.message;
}

function isDiffHunk(value: unknown): value is DiffHunk {
  if (!isRecord(value)) return false;
  return (
    typeof value.oldStart === "number" &&
    typeof value.oldLines === "number" &&
    typeof value.newStart === "number" &&
    typeof value.newLines === "number" &&
    Array.isArray(value.lines) &&
    value.lines.every((line) => typeof line === "string")
  );
}

function boundDiffHunks(hunks: DiffHunk[]): { patch: DiffHunk[]; truncated: boolean } {
  const bounded: DiffHunk[] = [];
  let remainingLines = MAX_DISPLAY_DIFF_LINES;
  let truncated = hunks.length > MAX_DISPLAY_DIFF_HUNKS;

  for (const hunk of hunks.slice(0, MAX_DISPLAY_DIFF_HUNKS)) {
    if (remainingLines <= 0) {
      truncated = true;
      break;
    }

    const lines = hunk.lines.slice(0, remainingLines);
    bounded.push({ ...hunk, lines });
    remainingLines -= lines.length;
    if (lines.length < hunk.lines.length) {
      truncated = true;
      break;
    }
  }

  return { patch: bounded, truncated };
}
