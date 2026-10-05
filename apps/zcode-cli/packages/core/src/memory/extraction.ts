import type { MessageId, MessageWithParts, ToolPart } from "@zcode/contracts";
import { resolveContainedMemoryFilePath } from "./memory-file-path.js";
import { formatMemoryManifest } from "./recall/manifest.js";
import type { MemoryManifestEntry } from "./recall/types.js";

const MINIMUM_USER_WORDS = 3;

type MemoryExtractionExecutionStatus = "success" | "no-op" | "error" | "aborted";

export interface MemoryExtractionSnapshot {
  boundaryMessageId: MessageId;
  durableMessages: readonly MessageWithParts[];
  memoryRoot: string;
  workingDirectory: string;
  workspaceRoot: string;
}

type MemoryExtractionDecision =
  | { decision: "run"; messageCount: number }
  | {
      decision: "skip";
      messageCount: number;
      reason: "direct-memory-write" | "no-user-prose";
    };

interface MemoryExtractionExecutionInput {
  abortSignal: AbortSignal;
  messageCount: number;
  snapshot: MemoryExtractionSnapshot;
}

/** session entry type：memory 抽取 cursor（0B-4）。开放 string 类型面，不入 SESSION_ENTRY_TYPES 常量表。 */
export const MEMORY_EXTRACTION_CURSOR_ENTRY_TYPE = "runtime/memory_extraction_cursor";

export interface MemoryExtractionSchedulerOptions {
  /**
   * 0B-4（升级实施手册）：cursor 持久化钩子。`loadCursor` 在首个快照处理前恢复一次
   * （重启后只抽新增段，不再全史重抽）；`onCursorAdvance` 在 cursor 推进（skip 或
   * success/no-op）时同步回调，落盘失败由调用方吞——内存 cursor 已推进，下次推进重写。
   * 两者缺席即纯内存旧语义（测试装配零改动）。
   */
  loadCursor?: () => Promise<MessageId | undefined>;
  onCursorAdvance?: (cursor: MessageId) => void;
}

export interface MemoryExtractionScheduler<
  TSnapshot extends MemoryExtractionSnapshot = MemoryExtractionSnapshot,
> {
  drain(): Promise<void>;
  getCursor(): MessageId | undefined;
  hasPendingWork(): boolean;
  schedule(snapshot: TSnapshot | Promise<TSnapshot>): void;
  shutdown(): void;
}

export function buildMemoryExtractionPrompt(input: {
  manifest: readonly MemoryManifestEntry[];
  messageCount: number;
}): string {
  const existingMemories =
    input.manifest.length > 0
      ? `\n\n## Existing memory files\n\n${formatMemoryManifest(input.manifest)}\n\nCheck this list before writing \u2014 update an existing file rather than creating a duplicate.`
      : "";

  return [
    `You are now acting as the memory extraction subagent. Analyze the most recent ~${input.messageCount} messages above and use them to update your persistent memory systems.`,
    "",
    "Available tools: Read, Grep, Glob, read-only Bash (ls/find/cat/stat/wc/head/tail and similar), and Edit/Write for paths inside the memory directory only, and Bash rm with paths inside the memory directory only. All other tools \u2014 MCP, Agent, write-capable Bash, etc \u2014 will be denied.",
    "",
    "You have a limited turn budget. Edit requires a prior Read of the same file, so the efficient strategy is: turn 1 \u2014 issue all Read calls in parallel for every file you might update; turn 2 \u2014 issue all Write/Edit calls in parallel. Do not interleave reads and writes across multiple turns.",
    "",
    `You MUST only use content from the last ~${input.messageCount} messages to update your persistent memories. Do not waste any turns attempting to investigate or verify that content further \u2014 no grepping source files, no reading code to confirm a pattern exists, no git commands.${existingMemories}`,
    "",
    "If nothing is worth saving, output only 'Nothing to save.' Do not explain why.",
    "",
    "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
    "",
    "Apply the memory types, what-not-to-save criteria, and frontmatter format from the Memory section of your system prompt \u2014 it is already in your context above.",
  ].join("\n");
}

function evaluateMemoryExtraction(
  snapshot: MemoryExtractionSnapshot,
  cursor: MessageId | undefined,
): MemoryExtractionDecision {
  const messageCount = countMessagesAfterCursor(snapshot.durableMessages, cursor);

  if (containsDirectMemoryWrite(snapshot, cursor)) {
    return { decision: "skip", messageCount, reason: "direct-memory-write" };
  }

  if (!containsEligibleUserProse(snapshot.durableMessages, cursor)) {
    return { decision: "skip", messageCount, reason: "no-user-prose" };
  }

  return { decision: "run", messageCount };
}

export function createMemoryExtractionScheduler<
  TSnapshot extends MemoryExtractionSnapshot = MemoryExtractionSnapshot,
>(
  execute: (
    input: Omit<MemoryExtractionExecutionInput, "snapshot"> & { snapshot: TSnapshot },
  ) => Promise<MemoryExtractionExecutionStatus>,
  options?: MemoryExtractionSchedulerOptions,
): MemoryExtractionScheduler<TSnapshot> {
  let cursor: MessageId | undefined;
  let latestPending: Promise<SnapshotAcquisition<TSnapshot>> | undefined;
  let running: Promise<void> | undefined;
  let shuttingDown = false;
  const shutdownController = new AbortController();
  // 0B-4：恢复只做一次——首个快照处理前 await；失败按全量（undefined）处理，不阻塞抽取。
  const restoreCursor = options?.loadCursor?.().then(
    (restored) => {
      if (cursor === undefined && restored !== undefined) cursor = restored;
    },
    () => undefined,
  );
  const advanceCursor = (next: MessageId): void => {
    cursor = next;
    options?.onCursorAdvance?.(next);
  };

  const processSnapshot = async (snapshot: TSnapshot): Promise<void> => {
    await restoreCursor;
    const decision = evaluateMemoryExtraction(snapshot, cursor);
    const snapshotEnd = snapshot.boundaryMessageId;

    if (decision.decision === "skip") {
      if (snapshotEnd) advanceCursor(snapshotEnd);
      return;
    }

    let status: MemoryExtractionExecutionStatus;
    try {
      status = await execute({
        abortSignal: shutdownController.signal,
        messageCount: decision.messageCount,
        snapshot,
      });
    } catch {
      return;
    }

    if (!shuttingDown && (status === "success" || status === "no-op") && snapshotEnd) {
      advanceCursor(snapshotEnd);
    }
  };

  const run = async (first: Promise<SnapshotAcquisition<TSnapshot>>): Promise<void> => {
    try {
      let current: Promise<SnapshotAcquisition<TSnapshot>> | undefined = first;
      while (current && !shuttingDown) {
        const acquisition = await waitForSnapshotAcquisitionOrShutdown(
          current,
          shutdownController.signal,
        );
        if (acquisition.status === "shutdown" || shuttingDown) break;
        if (acquisition.status === "acquired") {
          try {
            await processSnapshot(acquisition.snapshot);
          } catch {
            // 本次 error 不推进 cursor；latest pending 仍按既有 coalescing 语义继续。
          }
        }
        current = shuttingDown ? undefined : latestPending;
        latestPending = undefined;
      }
    } finally {
      if (shuttingDown) latestPending = undefined;
      running = undefined;
    }
  };

  return {
    async drain() {
      while (running) {
        await running;
      }
    },
    getCursor() {
      return cursor;
    },
    hasPendingWork() {
      return running !== undefined || latestPending !== undefined;
    },
    schedule(snapshot) {
      if (shuttingDown) return;
      const acquisition = acquireSnapshot(snapshot);
      if (running) {
        latestPending = acquisition;
        return;
      }

      running = run(acquisition);
    },
    shutdown() {
      if (shuttingDown) return;
      // ZCode 关闭单个 session 后进程仍继续运行；旧 scheduler 只让调用方
      // 放弃等待，running/pending Extraction 仍可能继续请求模型和写 Memory。
      shuttingDown = true;
      latestPending = undefined;
      shutdownController.abort();
    },
  };
}

type SnapshotAcquisition<TSnapshot> =
  | { status: "acquired"; snapshot: TSnapshot }
  | { status: "error" };

type SnapshotAcquisitionWait<TSnapshot> = SnapshotAcquisition<TSnapshot> | { status: "shutdown" };

function acquireSnapshot<TSnapshot>(
  snapshot: TSnapshot | Promise<TSnapshot>,
): Promise<SnapshotAcquisition<TSnapshot>> {
  return Promise.resolve(snapshot).then(
    (value) => ({ status: "acquired", snapshot: value }),
    () => ({ status: "error" }),
  );
}

function waitForSnapshotAcquisitionOrShutdown<TSnapshot>(
  acquisition: Promise<SnapshotAcquisition<TSnapshot>>,
  signal: AbortSignal,
): Promise<SnapshotAcquisitionWait<TSnapshot>> {
  if (signal.aborted) return Promise.resolve({ status: "shutdown" });

  return new Promise((resolve) => {
    const onAbort = (): void => {
      cleanup();
      resolve({ status: "shutdown" });
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void acquisition.then((result) => {
      cleanup();
      resolve(result);
    });
  });
}

function countMessagesAfterCursor(
  messages: readonly MessageWithParts[],
  cursor: MessageId | undefined,
): number {
  if (!cursor) return messages.length;
  const cursorIndex = messages.findIndex((message) => message.info.id === cursor);
  return cursorIndex < 0 ? messages.length : messages.length - cursorIndex - 1;
}

function containsDirectMemoryWrite(
  snapshot: MemoryExtractionSnapshot,
  cursor: MessageId | undefined,
): boolean {
  const messages = messagesAfterFoundCursor(snapshot.durableMessages, cursor);
  if (!messages) return false;

  for (const message of messages) {
    if (message.info.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!isMemoryMutationToolPart(part)) continue;
      const filePath = part.state.input.file_path;
      if (typeof filePath !== "string" || filePath.length === 0) continue;
      if (
        resolveContainedMemoryFilePath({
          filePath,
          rootDir: snapshot.memoryRoot,
          workingDirectory: snapshot.workingDirectory,
          workspaceRoot: snapshot.workspaceRoot,
        })
      ) {
        return true;
      }
    }
  }

  return false;
}

function containsEligibleUserProse(
  messages: readonly MessageWithParts[],
  cursor: MessageId | undefined,
): boolean {
  const messagesAfterCursor = messagesAfterFoundCursor(messages, cursor) ?? messages;
  for (const message of messagesAfterCursor) {
    if (!isNonMetaUserMessage(message)) continue;
    for (const part of message.parts) {
      if (
        part.type === "text" &&
        part.ignored !== true &&
        part.synthetic !== true &&
        countWords(part.text) >= MINIMUM_USER_WORDS
      ) {
        return true;
      }
    }
  }
  return false;
}

function messagesAfterFoundCursor(
  messages: readonly MessageWithParts[],
  cursor: MessageId | undefined,
): readonly MessageWithParts[] | undefined {
  if (!cursor) return messages;
  const cursorIndex = messages.findIndex((message) => message.info.id === cursor);
  return cursorIndex < 0 ? undefined : messages.slice(cursorIndex + 1);
}

function isNonMetaUserMessage(message: MessageWithParts): boolean {
  return (
    message.info.role === "user" &&
    message.info.synthetic !== true &&
    message.info.visibility !== "model-only"
  );
}

function isMemoryMutationToolPart(part: MessageWithParts["parts"][number]): part is ToolPart {
  return part.type === "tool" && (part.tool === "Write" || part.tool === "Edit");
}

function countWords(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length;
}
