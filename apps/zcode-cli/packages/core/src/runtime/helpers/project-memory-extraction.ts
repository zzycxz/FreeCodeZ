import type { MessageId } from "@zcode/contracts";
import { MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE } from "../../compact/microcompact.js";
import { selectActiveConversationBranch, type TraceContext } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { MessageWithParts } from "@zcode/contracts";
import {
  buildMemoryExtractionPrompt,
  createMemoryExtractionScheduler,
  MEMORY_EXTRACTION_CURSOR_ENTRY_TYPE,
  type MemoryExtractionScheduler,
  type MemoryExtractionSnapshot,
} from "../../memory/extraction.js";
import { runMemoryAgentLoop } from "../../memory/memory-agent-loop.js";
import { scanMemoryManifest } from "../../memory/recall/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  buildProjectMemoryAgentProviderMessages,
  captureProjectMemoryAgentContext,
  createProjectMemoryAgentToolExecutor,
  type ProjectMemoryAgentContext,
} from "./project-memory-agent.js";
import { resolveEnabledProjectMemoryRoot } from "./project-memory.js";

const EXTRACTION_MAX_TURNS = 5;
const EXTRACTION_DRAIN_TIMEOUT_MS = 60_000;

interface ProjectMemoryExtractionSnapshot
  extends MemoryExtractionSnapshot, ProjectMemoryAgentContext {}

export type ProjectMemoryExtractionScheduler =
  MemoryExtractionScheduler<ProjectMemoryExtractionSnapshot>;

export function isProjectMemoryEnabled(this: AgentRuntimeInternal): boolean {
  return resolveEnabledProjectMemoryRoot(this.config, this.workspaceRoot) !== undefined;
}

export function scheduleProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  input: { model: ProjectMemoryAgentContext["model"]; traceContext: TraceContext },
): void {
  if (runtime.shuttingDown) return;
  // 原因：headless 只关闭自动 Extraction，必须在读取快照或访问文件前返回，避免后台副作用。
  if (runtime.config.memory?.extractionEnabled === false) return;
  // Bash cd 只改变执行 cwd，project Memory 身份必须继续使用会话 workspace root。
  const memoryRoot = resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot);
  if (!memoryRoot) return;
  if (runtime.isRemoteWorkspace()) return;
  if (!runtime.sessionStore || !runtime.fileSystemPort) return;

  const snapshotBase = captureProjectMemoryAgentContext(runtime, {
    memoryRoot,
    model: input.model,
    operation: "project_memory_extract",
    traceContext: input.traceContext,
  });
  const snapshotBoundaryMessageId = runtime.latestConversationMessageId;
  if (!snapshotBoundaryMessageId) return;
  const durableMessages = runtime.sessionStore.messages({ sessionID: runtime.sessionId });
  const session = runtime.sessionStore.getSession(runtime.sessionId);
  const snapshot = Promise.all([durableMessages, session]).then(
    ([messages, scheduledSession]): ProjectMemoryExtractionSnapshot => {
      const activeMessages = selectActiveConversationBranch(messages, {
        branchCutAfterMessageId: scheduledSession?.revert?.branchCutAfterMessageID,
        rewindCreatedMessageId: scheduledSession?.revert?.createdMessageID,
        rewindKeptMessageIds: scheduledSession?.revert?.keptMessageIDs,
        rewindTargetMessageId: scheduledSession?.revert?.targetMessageID,
      });
      const boundaryIndex = activeMessages.findIndex(
        (message) => message.info.id === snapshotBoundaryMessageId,
      );
      if (boundaryIndex < 0) {
        throw new Error("Extraction boundary is missing from the scheduled active branch");
      }
      return {
        ...snapshotBase,
        boundaryMessageId: snapshotBoundaryMessageId,
        durableMessages: activeMessages.slice(0, boundaryIndex + 1),
        // 0C-2②（升级实施手册）：providerEntries 拍自内存 messageHistory——microcompact
        // 已把旧工具结果换成占位符（那是模型上下文的省 token 视角），抽取 subagent 的
        // 输入不该被侵蚀：按 toolCallId 从持久化消息找回原文。只替换命中占位符的条目，
        // 其余逐字保留（零保真风险）；占位符不在场时零拷贝。
        providerEntries: restoreClearedToolResults(
          snapshotBase.providerEntries,
          activeMessages.slice(0, boundaryIndex + 1),
        ),
      };
    },
  );

  runtime.memoryExtractionScheduler ??= createMemoryExtractionScheduler(
    (extraction) => executeProjectMemoryExtraction(runtime, extraction),
    {
      // 0B-4（升级实施手册）：cursor 落 session entry——重启后只抽新增段（旧版纯内存
      // cursor，冷恢复必然全史重抽）。读取失败按全量处理（宁重抽不漏抽）；落盘在
      // 会话行未落地（0B-1 同款 FK 窗口）或写入失败时静默跳过——内存 cursor 已推进，
      // 下次推进重写同一稳定 entry。
      loadCursor: () => loadPersistedMemoryExtractionCursor(runtime),
      onCursorAdvance: (cursor) => {
        void persistMemoryExtractionCursor(runtime, cursor);
      },
    },
  );
  runtime.memoryExtractionScheduler.schedule(snapshot);
}

/**
 * 0C-2②：恢复被 microcompact 清掉的工具结果。占位符消息保留 role/toolCallId/toolName、
 * 只换 content——按 toolCallId 在持久化消息里找回原输出。找不到（理论上不应发生，
 * 防御）保持占位符，抽取 subagent 至少还能看到"曾有一个被清理的结果"。
 */
export function restoreClearedToolResults(
  entries: readonly RuntimeMessageEntry[],
  durableMessages: readonly MessageWithParts[],
): RuntimeMessageEntry[] {
  const needsRestore = entries.some((entry) => isClearedToolResultEntry(entry));
  if (!needsRestore) return [...entries];
  const outputsByToolCallId = new Map<string, unknown>();
  for (const message of durableMessages) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      const toolPart = part as { toolCallId?: string; state?: { output?: unknown } };
      if (typeof toolPart.toolCallId === "string") {
        outputsByToolCallId.set(toolPart.toolCallId, toolPart.state?.output);
      }
    }
  }
  return entries.map((entry) => {
    if (!isClearedToolResultEntry(entry) || !("message" in entry)) return entry;
    const toolCallId = entry.message.toolCallId;
    const original = toolCallId === undefined ? undefined : outputsByToolCallId.get(toolCallId);
    if (original === undefined) return entry;
    return {
      ...entry,
      message: { ...entry.message, content: serializeDurableToolOutput(original) },
    };
  });
}

function isClearedToolResultEntry(entry: RuntimeMessageEntry): boolean {
  if (!("message" in entry)) return false;
  const message = entry.message;
  return (
    message.role === "tool" &&
    message.content === MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE &&
    typeof message.toolCallId === "string" &&
    message.toolCallId.length > 0
  );
}

function serializeDurableToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

const MEMORY_EXTRACTION_CURSOR_ENTRY_ID = "memory-extraction-cursor";

async function loadPersistedMemoryExtractionCursor(
  runtime: AgentRuntimeInternal,
): Promise<MessageId | undefined> {
  if (!runtime.sessionStore?.sessionEntries) return undefined;
  try {
    const entries = await runtime.sessionStore.sessionEntries({
      sessionID: runtime.sessionId,
      type: MEMORY_EXTRACTION_CURSOR_ENTRY_TYPE,
    });
    const latest = entries.at(-1);
    const cursor = (latest?.data as { cursorMessageId?: unknown } | undefined)?.cursorMessageId;
    return typeof cursor === "string" && cursor.length > 0
      ? (cursor as MessageId)
      : undefined;
  } catch {
    return undefined;
  }
}

async function persistMemoryExtractionCursor(
  runtime: AgentRuntimeInternal,
  cursor: string,
): Promise<void> {
  if (!runtime.sessionStore?.saveSessionEntry) return;
  if (!runtime.sessionPersisted) return;
  const timestamp = Date.now();
  try {
    await runtime.sessionStore.saveSessionEntry({
      id: `${runtime.sessionId}:${MEMORY_EXTRACTION_CURSOR_ENTRY_ID}`,
      sessionID: runtime.sessionId,
      type: MEMORY_EXTRACTION_CURSOR_ENTRY_TYPE,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      // 后台抽取的记账不是用户活动，不触碰 session.time_updated（与 model-selection 同款论证）。
      data: { cursorMessageId: cursor },
    });
  } catch {
    // 落盘失败不回滚内存 cursor：下次推进重写同一 entry；最坏退化是重启后重抽一段。
  }
}

export async function drainMemoryExtractions(
  this: AgentRuntimeInternal,
  timeoutMs: number | null = EXTRACTION_DRAIN_TIMEOUT_MS,
): Promise<void> {
  const scheduler = this.memoryExtractionScheduler;
  if (!scheduler) return;
  // benchmark 显式等待自然结束；普通 session close 仍保留原有有界取消清理。
  if (timeoutMs === null) {
    await scheduler.drain();
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      scheduler.drain(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function executeProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal: AbortSignal;
    messageCount: number;
    snapshot: ProjectMemoryExtractionSnapshot;
  },
) {
  const telemetry = runtime.agentTelemetry.detached({
    causation: input.snapshot.causation,
    executionKind: "background",
    operation: "project_memory_extract",
    targetKind: "project_memory",
    traceContext: input.snapshot.traceContext,
    trigger: "scheduler",
  });

  return telemetry.run(async () => {
    try {
      const manifest = await scanMemoryManifest({
        fileSystem: runtime.fileSystemPort!,
        rootDir: input.snapshot.memoryRoot,
        signal: input.abortSignal,
      });
      if (input.abortSignal.aborted) {
        telemetry.finishCancelled("abort_signal");
        return "aborted" as const;
      }
      const prompt = buildMemoryExtractionPrompt({
        manifest,
        messageCount: input.messageCount,
      });
      const providerMessages = buildProjectMemoryAgentProviderMessages(
        runtime,
        input.snapshot,
        prompt,
      );
      const executor = createProjectMemoryAgentToolExecutor(runtime, input.snapshot);

      await runMemoryAgentLoop({
        abortSignal: input.abortSignal,
        executeTool: (toolCall, options) =>
          executor.execute(toolCall, {
            signal: options.abortSignal,
            traceContext: input.snapshot.traceContext,
          }),
        maxTurns: EXTRACTION_MAX_TURNS,
        messages: providerMessages,
        model: input.snapshot.model,
        rootDir: input.snapshot.memoryRoot,
        tools: input.snapshot.tools,
        workingDirectory: input.snapshot.workingDirectory,
        workspaceRoot: input.snapshot.workspaceRoot,
      });
      telemetry.finishCompleted();
      return "success" as const;
    } catch (error) {
      if (input.abortSignal.aborted || isAbortError(error)) {
        telemetry.finishCancelled("abort_signal");
        return "aborted" as const;
      }
      telemetry.finishFailed("execute", "internal", error);
      return "error" as const;
    }
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
