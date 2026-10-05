// 任务桥接（附录B §4.3/§2.5）：IZCodeTaskService 建/续任务、发 prompt、订阅任务流，
// 广播 bots:task / bots:task-stream；watchTaskStream（tS）按 replyMode 四档渲染回发。
// 失败路径含 sessionExpired 归一（/Session (not found|is not active):/i → sessionExpiredNewTaskHint）。
/* eslint-disable max-lines -- 任务流订阅状态机（tS 全量语义：四档渲染/权限/问答/终态收口）与桥接 API 同文件，避免拆散事件序追踪。 */
import { randomUUID } from "node:crypto";
import type {
  ModelSelection,
  ZCodeStreamEvent,
  ZCodeTaskMeta,
  ZCodeTaskSnapshot,
  ZCodePromptAttachment,
} from "@zcode/shared";
import type { BotActor, BotConfig, BotContext, OutboundMessage, ReplyMode } from "@zcode/shared/bots";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import type { BotsRepo } from "./botsRepo.js";
import type { BotResourceRegistry } from "./resourceRegistry.js";
import {
  blocksToMessages,
  createAssistantReplyBlocks,
  createPermissionSelection,
  extractBotAssistantResponseMessages,
  formatBotToolCallReply,
  formatBotToolCallSummaryLine,
  formatStatusStreamToolProgress,
  formatStatusToolProgress,
  isBotToolCallReplyTerminal,
  normalizeInlineText,
  readStatusStringField,
  truncateLiveStatusProgressText,
  truncateStatusProgressText,
  type BotChangeSummary,
  type BotReplyPart,
  type BotReplyToolCall,
  type BotStreamToolProgressLike,
} from "./replyPipeline.js";
import { createCompletedElicitationOutbound, createOutbound } from "./commandHandlers.js";
import {
  createBotElicitationRequestSnapshot,
  createBotElicitationSelection,
  createElicitationView,
  normalizeBotElicitationQuestions,
  readBotElicitationRenderContext,
  getActorKey,
  toPendingElicitationRenderContext,
  type ElicitationRequestLike,
} from "./elicitation.js";
import { formatBotMessage, type BotHostLocale } from "./hostMessages.js";
import type { BotStreamingSender } from "./providers/feishuStreaming.js";
import type { BotTaskServiceLike, BotTaskStreamEvent } from "./taskServiceLike.js";

export const BOTS_TASK_TOPIC = "bots:task";
export const BOTS_TASK_STREAM_TOPIC = "bots:task-stream";
/** typing 重发节奏（附录B 核心常量：typing 重发 4000ms）。 */
export const TYPING_RESEND_MS = 4000;

export interface BotBroadcastPayload {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  event: string;
  updatedAt: number;
  [key: string]: unknown;
}

export interface BotTaskBridgeOptions {
  taskService: BotTaskServiceLike;
  sendBroadcast?: (message: { channel: string; payload: unknown }) => Promise<void>;
  repo: BotsRepo;
  resourceRegistry: BotResourceRegistry;
  sendOutbound: (
    bot: BotConfig,
    outbound: OutboundMessage,
    options?: { taskId?: string },
  ) => Promise<void>;
  sendTyping?: (bot: BotConfig, actor: BotActor) => Promise<void>;
  /** 官方 stopTyping（K/G）：取消 typing 指示（飞书 DELETE reaction）。 */
  stopTyping?: (bot: BotConfig, actor: BotActor) => Promise<void>;
  /**
   * 官方 tS task_complete/task_error 的 transient 交互卡终态收口（Mt）：
   * 登记 taskId 命中才 PATCH 终态卡 + 注销登记。
   */
  finalizeTransientInteractionCard?: (params: {
    bot: BotConfig;
    actor: BotActor;
    taskId: string;
    outbound: OutboundMessage;
  }) => Promise<void>;
  /** streaming_card 档的渠道 sender（飞书/Lark 流式卡）；无则回落普通消息。 */
  createStreamingSender?: (params: {
    bot: BotConfig;
    providerUserId: string;
    locale: BotHostLocale;
  }) => BotStreamingSender | null;
  logger: ServiceLogger;
  now?: () => number;
  /** typing 重发间隔（默认 TYPING_RESEND_MS=4000；测试注入小值）。 */
  typingResendMs?: number;
}

export interface WatchTaskStreamParams {
  bot: BotConfig;
  actor: BotActor;
  context: BotContext;
  locale: BotHostLocale;
  taskId: string;
  /** watchAutomationRun 强制 summary_changes（附录B §9）。 */
  forceMode?: ReplyMode;
}

function createTraceId(): string {
  return randomUUID();
}

export function isSessionExpiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\bSession (not found|is not active):/iu.test(message);
}

export function formatUserFacingBotError(
  error: unknown,
  locale: BotHostLocale | undefined,
): string {
  return isSessionExpiredError(error)
    ? formatBotMessage(locale, "sessionExpiredNewTaskHint")
    : error instanceof Error
      ? error.message
      : String(error ?? "");
}

/** jZ buildPerTurnChangeSummaries：按 turn 聚合文件快照行差（去重合并写入次数）。 */
export interface BotTurnFileSnapshot {
  path: string;
  beforeContent: string;
  afterContent: string;
  writeCount: number;
}

export interface BotTurnSnapshots {
  turnIndex: number;
  snapshots: BotTurnFileSnapshot[];
}

function countLineDiff(before: string, after: string): { added: number; removed: number } {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const counts = new Map<string, number>();
  for (const line of beforeLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let matched = 0;
  for (const line of afterLines) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) {
      counts.set(line, remaining - 1);
      matched += 1;
    }
  }
  return { added: afterLines.length - matched, removed: beforeLines.length - matched };
}

export function buildPerTurnChangeSummaries(
  turns: readonly BotTurnSnapshots[],
): Map<number, BotChangeSummary> {
  const summaries = new Map<number, BotChangeSummary>();
  for (const turn of turns) {
    if (turn.snapshots.length === 0) continue;
    const byPath = new Map<string, BotTurnFileSnapshot>();
    for (const snapshot of turn.snapshots) {
      const existing = byPath.get(snapshot.path);
      if (existing) {
        existing.afterContent = snapshot.afterContent;
        existing.writeCount += snapshot.writeCount;
      } else {
        byPath.set(snapshot.path, { ...snapshot });
      }
    }
    let addedTotal = 0;
    let removedTotal = 0;
    const files = [...byPath.entries()]
      .map(([path, snapshot]) => {
        const diff = countLineDiff(snapshot.beforeContent, snapshot.afterContent);
        addedTotal += diff.added;
        removedTotal += diff.removed;
        return {
          path,
          added: diff.added,
          removed: diff.removed,
          writeCount: snapshot.writeCount,
          lastTurnIndex: turn.turnIndex,
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
    summaries.set(turn.turnIndex, {
      fileCount: files.length,
      added: addedTotal,
      removed: removedTotal,
      files,
    });
  }
  return summaries;
}

export class BotTaskBridge {
  private readonly options: BotTaskBridgeOptions;
  private readonly now: () => number;
  private readonly runningTaskIds = new Set<string>();
  /** 实时进展登记（官方 updateLiveStatusProgress 的 p 表）：任务流最新进展/最后工具行。 */
  private readonly liveStatusProgress = new Map<
    string,
    { kind: "message" | "thought" | "tool"; text: string }
  >();
  /** 任务 typing 登记（官方 l 表，仅 stopTyping 型渠道）：taskId → 挂载目标，供 stopInboundTyping（G）守卫。 */
  private readonly typingTargets = new Map<string, { botId: string; providerMessageId?: string }>();
  /** 本轮运行起点（sendPrompt/watch 起算）与上一轮耗时（终态记录）。 */
  private readonly runStartedAt = new Map<string, number>();
  private readonly lastRunDurationMs = new Map<string, number>();

  constructor(options: BotTaskBridgeOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  isTaskRunning(taskId: string | null | undefined): boolean {
    return Boolean(taskId && this.runningTaskIds.has(taskId));
  }

  /** 本轮运行起点登记（[已工作] 时长起算点）。 */
  markTaskRunStarted(taskId: string): void {
    this.runningTaskIds.add(taskId);
    if (!this.runStartedAt.has(taskId)) this.runStartedAt.set(taskId, this.now());
  }

  /**
   * updateLiveStatusProgress（ee）：任务流事件 → 实时进展（最新进展/最后工具行）。
   * message/thought 同类续写、工具行整体替换；文本留末尾 1000 字符。
   */
  updateLiveStatusProgress(taskId: string, event: BotTaskStreamEvent): void {
    if (!taskId) return;
    if (event.type === "agent_message_chunk" || event.type === "agent_thought_chunk") {
      const text = normalizeInlineText((event as { content?: string }).content ?? "");
      if (!text) return;
      const kind = event.type === "agent_message_chunk" ? ("message" as const) : ("thought" as const);
      const previous = this.liveStatusProgress.get(taskId);
      const merged = previous?.kind === kind ? `${previous.text}${text}` : text;
      this.liveStatusProgress.set(taskId, {
        kind,
        text: truncateLiveStatusProgressText(merged),
      });
      return;
    }
    if (event.type === "tool_call" || event.type === "tool_call_update") {
      const text = formatStatusStreamToolProgress(
        event as unknown as Parameters<typeof formatStatusStreamToolProgress>[0],
      );
      if (text) {
        this.liveStatusProgress.set(taskId, { kind: "tool", text: truncateLiveStatusProgressText(text) });
      }
    }
  }

  /** 状态文本 [进展] 行数据源；拿不到进展返回 undefined（缺省省略）。 */
  getTaskLiveStatusProgress(taskId: string | null | undefined): string | undefined {
    return taskId ? this.liveStatusProgress.get(taskId)?.text : undefined;
  }

  /**
   * readTaskWorkedDurationMs（YZ 简化）：[已工作] 任务运行耗时。
   * 运行中 = now - 本轮起点（回落 meta.createdAt）；已结束 = 上一轮耗时（回落 meta 区间）。
   */
  readTaskWorkedDurationMs(
    taskId: string | null | undefined,
    meta: Pick<ZCodeTaskMeta, "createdAt" | "updatedAt" | "status"> | null,
  ): number | null {
    if (!taskId || !meta) return null;
    const running = this.isTaskRunning(taskId) || meta.status == null || meta.status === "running";
    if (running) {
      const startedAt = this.runStartedAt.get(taskId) ?? meta.createdAt ?? meta.updatedAt;
      return typeof startedAt === "number" ? Math.max(this.now() - startedAt, 0) : null;
    }
    const tracked = this.lastRunDurationMs.get(taskId);
    if (tracked !== undefined) return tracked;
    return meta.updatedAt >= meta.createdAt ? meta.updatedAt - meta.createdAt : null;
  }

  markTaskFinished(taskId: string): void {
    this.runningTaskIds.delete(taskId);
    // 终态收口：记录本轮耗时供 [已工作] 使用；实时进展清空（官方 p.delete 语义，无条件）
    const startedAt = this.runStartedAt.get(taskId);
    if (startedAt !== undefined) {
      this.lastRunDurationMs.set(taskId, Math.max(this.now() - startedAt, 0));
      this.runStartedAt.delete(taskId);
    }
    this.liveStatusProgress.delete(taskId);
  }

  /** 命令侧读取 task meta（失败回落 null）。 */
  async getTaskMetaSafe(params: {
    taskId: string;
    context: Pick<BotContext, "workspacePath" | "workspaceIdentity">;
  }): Promise<ZCodeTaskMeta | null> {
    try {
      return await this.options.taskService.getTaskMeta({
        taskId: params.taskId,
        workspacePath: params.context.workspacePath,
        ...(params.context.workspaceIdentity
          ? { workspaceIdentity: params.context.workspaceIdentity }
          : {}),
      });
    } catch {
      return null;
    }
  }

  /** getTaskSnapshotSafe（官方 eT 的 `getTaskSnapshot(...).catch(()=>null)`）。 */
  async getTaskSnapshotSafe(params: {
    taskId: string;
    context: Pick<BotContext, "workspacePath" | "workspaceIdentity">;
  }): Promise<ZCodeTaskSnapshot | null> {
    try {
      return await this.options.taskService.getTaskSnapshot({
        taskId: params.taskId,
        workspacePath: params.context.workspacePath,
        ...(params.context.workspaceIdentity
          ? { workspaceIdentity: params.context.workspaceIdentity }
          : {}),
      });
    } catch {
      return null;
    }
  }

  /** 进展兜底（官方 `p.get(taskId)?.text??tH(V)` 的 tH 支路）：实时登记缺失时读任务快照。 */
  async readTaskSnapshotProgressSafe(params: {
    taskId: string;
    context: Pick<BotContext, "workspacePath" | "workspaceIdentity">;
  }): Promise<string | null> {
    const snapshot = await this.getTaskSnapshotSafe(params);
    return readLatestTaskProgress(snapshot);
  }

  async respondElicitationSafe(params: {
    context: Pick<BotContext, "workspacePath" | "workspaceIdentity">;
    taskId: string;
    runId: string;
    requestId: string;
    action: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
  }): Promise<boolean> {
    return this.options.taskService.respondElicitation({
      taskId: params.taskId,
      workspacePath: params.context.workspacePath,
      ...(params.context.workspaceIdentity
        ? { workspaceIdentity: params.context.workspaceIdentity }
        : {}),
      runId: params.runId,
      requestId: params.requestId,
      action: params.action,
      ...(params.content ? { content: params.content } : {}),
    });
  }

  async respondPermissionSafe(params: {
    context: Pick<BotContext, "workspacePath" | "workspaceIdentity">;
    taskId: string;
    requestId: string;
    optionId: string;
    response: unknown;
  }): Promise<boolean> {
    return this.options.taskService.respondPermission({
      taskId: params.taskId,
      workspacePath: params.context.workspacePath,
      ...(params.context.workspaceIdentity
        ? { workspaceIdentity: params.context.workspaceIdentity }
        : {}),
      requestId: params.requestId,
      optionId: params.optionId,
      response: params.response as never,
    });
  }

  async stopGenerationSafe(params: {
    context: Pick<BotContext, "workspacePath" | "workspaceIdentity">;
    taskId: string;
  }): Promise<void> {
    await this.options.taskService.stopGeneration({
      taskId: params.taskId,
      workspacePath: params.context.workspacePath,
      ...(params.context.workspaceIdentity
        ? { workspaceIdentity: params.context.workspaceIdentity }
        : {}),
    });
    this.runningTaskIds.delete(params.taskId);
  }

  async listDeletedTaskIdsSafe(params: {
    context: Pick<BotContext, "workspacePath" | "workspaceIdentity">;
  }): Promise<string[]> {
    try {
      return await this.options.taskService.listDeletedTaskIds({
        workspacePath: params.context.workspacePath,
        ...(params.context.workspaceIdentity
          ? { workspaceIdentity: params.context.workspaceIdentity }
          : {}),
      });
    } catch {
      return [];
    }
  }

  async listTasksSafe(params: {
    context: Pick<BotContext, "workspacePath" | "workspaceIdentity">;
  }): Promise<ZCodeTaskMeta[]> {
    try {
      return await this.options.taskService.listTasks({
        workspacePath: params.context.workspacePath,
        ...(params.context.workspaceIdentity
          ? { workspaceIdentity: params.context.workspaceIdentity }
          : {}),
      });
    } catch {
      return [];
    }
  }

  async setModelSafe(params: {
    taskId: string;
    modelSelection: ModelSelection;
  }): Promise<void> {
    await this.options.taskService.setModel({
      taskId: params.taskId,
      traceId: createTraceId(),
      modelSelection: params.modelSelection,
    });
  }

  async setConfigOptionSafe(params: {
    taskId: string;
    configId: string;
    value: string;
  }): Promise<void> {
    await this.options.taskService.setConfigOption({
      taskId: params.taskId,
      traceId: createTraceId(),
      configId: params.configId,
      value: params.value,
    });
  }

  async getTaskConfigOptionsSafe(taskId: string): Promise<
    Array<{
      id: string;
      name: string;
      type: "select" | "boolean";
      category?: string;
      currentValue: string | boolean;
      options?: Array<{ value: string; name: string; description?: string }>;
    }>
  > {
    try {
      return await this.options.taskService.getTaskConfigOptions({ taskId });
    } catch {
      return [];
    }
  }

  async deleteTaskSafe(params: {
    context: Pick<BotContext, "workspacePath" | "workspaceIdentity" | "botId">;
    taskId: string;
  }): Promise<void> {
    // R13：按 botId+taskId 释放任务级资源（此前误传空 botId 导致永不命中）
    this.options.resourceRegistry.releaseTaskResources(params.context.botId, params.taskId);
    this.markTaskFinished(params.taskId);
    this.lastRunDurationMs.delete(params.taskId);
    await this.options.taskService
      .deleteTask({
        taskId: params.taskId,
        workspacePath: params.context.workspacePath,
        ...(params.context.workspaceIdentity
          ? { workspaceIdentity: params.context.workspaceIdentity }
          : {}),
      })
      .catch(() => undefined);
  }

  async getTaskModelSelectionSafe(taskId: string): Promise<ModelSelection | null> {
    try {
      return await this.options.taskService.getTaskModelSelection({ taskId });
    } catch {
      return null;
    }
  }

  async broadcastTaskChange(
    context: Pick<BotContext, "workspacePath" | "workspaceIdentity">,
    taskId: string,
    event: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const payload: BotBroadcastPayload = {
      workspacePath: context.workspacePath,
      ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
      taskId,
      event,
      updatedAt: this.now(),
      ...extra,
    };
    await this.options.sendBroadcast?.({ channel: BOTS_TASK_TOPIC, payload });
  }

  async broadcastTaskStream(
    context: Pick<BotContext, "workspacePath" | "workspaceIdentity">,
    taskId: string,
    event: unknown,
  ): Promise<void> {
    const payload = {
      workspacePath: context.workspacePath,
      ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
      taskId,
      event,
      updatedAt: this.now(),
    };
    await this.options.sendBroadcast?.({ channel: BOTS_TASK_STREAM_TOPIC, payload });
  }

  async createBotTask(params: {
    context: BotContext;
    modelSelection: ModelSelection | undefined;
  }): Promise<ZCodeTaskMeta> {
    const task = await this.options.taskService.createTask({
      workspacePath: params.context.workspacePath,
      ...(params.context.workspaceIdentity
        ? { workspaceIdentity: params.context.workspaceIdentity }
        : {}),
      provider: "glm",
      ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
      // 0-4（升级实施手册）：bots 任务强制 yolo（§6.9 modeLocked）+ 公网聊天消息驱动，
      // 是提示注入的高危面；建任务时强制注入沙箱（E-S3 链透传到 session 创建）。
      // 平台可用性由沙箱执行体分发（wrapCommandWithSandbox）内部处理，此处只管声明。
      sandboxEnabled: true,
    });
    // 建任务后强制 yolo（§6.9 modeLocked）；失败不阻断建任务结果
    await this.options.taskService.setMode({ taskId: task.taskId, mode: "yolo" }).catch(() => undefined);
    return task;
  }

  async resumeBotTask(params: { context: BotContext; taskId: string }): Promise<void> {
    await this.options.taskService.resumeTask({
      taskId: params.taskId,
      workspacePath: params.context.workspacePath,
      ...(params.context.workspaceIdentity
        ? { workspaceIdentity: params.context.workspaceIdentity }
        : {}),
      // 0-4：与 createBotTask 对称——bots 任务恒 yolo，冷恢复/重启后不得丢沙箱防护
      // （任务 meta 不持久化沙箱位，resume 边界必须重新注入）。
      sandboxEnabled: true,
    });
  }

  /**
   * typing 心跳（官方 H/K + Nle=4e3 重发节奏）：入站开始即发、typingResendMs（默认 4000）节奏重发，
   * 返回停止句柄（终态 K 调用：清节奏 + provider.stopTyping 取消指示）。
   * 仅 stopTyping 型渠道（飞书 reaction）入 typingTargets 登记（官方 l 表），供 stopInboundTyping（G）守卫。
   */
  startTyping(bot: BotConfig, actor: BotActor, taskId: string): () => void {
    const stopTypingImpl = this.options.stopTyping;
    const tracked = Boolean(stopTypingImpl);
    if (tracked) {
      this.typingTargets.set(taskId, {
        botId: bot.id,
        providerMessageId: actor.providerMessageId,
      });
    }
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      if (tracked) this.typingTargets.delete(taskId);
      void stopTypingImpl?.(bot, actor).catch(() => undefined);
    };
    if (!this.options.sendTyping) return stop;
    const intervalMs = this.options.typingResendMs ?? TYPING_RESEND_MS;
    timer = setInterval(() => {
      void this.options.sendTyping?.(bot, actor).catch(() => undefined);
    }, intervalMs);
    timer.unref?.();
    void this.options.sendTyping(bot, actor).catch(() => undefined);
    return stop;
  }

  /** stopInboundTyping（G）守卫：任务 typing 挂在同一 providerMessageId 上时不取消（飞书 reaction 留给 K）。 */
  hasTypingTargetFor(botId: string, providerMessageId: string | undefined): boolean {
    if (!providerMessageId) return false;
    for (const target of this.typingTargets.values()) {
      if (target.botId === botId && target.providerMessageId === providerMessageId) return true;
    }
    return false;
  }

  /** sendPromptInBackground（tT）：fire-and-forget；失败广播 error + taskFailed/sessionExpired 文案。 */
  sendPromptInBackground(params: {
    bot: BotConfig;
    actor: BotActor;
    context: BotContext;
    taskId: string;
    traceId: string;
    content: string;
    attachments: ZCodePromptAttachment[];
    modelSelection?: ModelSelection;
  }): void {
    const { taskService } = this.options;
    void taskService
      .sendPrompt({
        taskId: params.taskId,
        traceId: params.traceId,
        content: params.content,
        ...(params.attachments.length > 0 ? { attachments: params.attachments } : {}),
        ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const text = isSessionExpiredError(error)
          ? formatBotMessage(undefined, "sessionExpiredNewTaskHint")
          : formatBotMessage(undefined, "taskFailed", {
              message: formatUserFacingBotError(error, undefined),
            });
        this.markTaskFinished(params.taskId);
        await this.broadcastTaskChange(params.context, params.taskId, "error", {
          error: message,
        }).catch(() => undefined);
        await this.options
          .sendOutbound(params.bot, {
            botId: params.bot.id,
            provider: params.bot.provider as OutboundMessage["provider"],
            providerUserId: params.actor.chatId ?? params.actor.providerUserId,
            text,
          })
          .catch(() => undefined);
      });
    this.markTaskRunStarted(params.taskId);
  }

  /**
   * 终态 transient 卡收口（官方 tS task_complete/task_error）：
   * ① `I.pendingElicitation?.taskId===he.taskId&&(Zf(...),$e({...I,pendingElicitation:void 0}))` 清问答状态；
   * ② `c.get(J(P))?.taskId===he.taskId && Mt(P, ...)` 对本任务登记的交互卡 PATCH 终态卡 + 注销：
   *    有 pending elicitation → 取消问答卡（eS "cancel"，status "cancelled"）；
   *    否则 → task_error 回 `taskFailed{message}`、task_complete 回 `received`（已收到。）文本卡。
   */
  private async finalizeTransientAtTaskEnd(
    params: WatchTaskStreamParams,
    event: BotTaskStreamEvent,
  ): Promise<void> {
    const hook = this.options.finalizeTransientInteractionCard;
    const taskId = event.taskId ?? params.taskId;
    const { bot, actor, context, locale } = params;
    const state = await this.options.repo.readState().catch(() => null);
    const botState = state?.bots[context.botId];
    const pending =
      botState?.pendingElicitation?.taskId === taskId ? botState.pendingElicitation : undefined;
    if (pending) {
      this.options.resourceRegistry.releaseScoped(context.botId, `elicitation:${pending.requestId}`);
      await this.options.repo.updateState((current) => {
        const entry = current.bots[context.botId];
        if (!entry?.pendingElicitation || entry.pendingElicitation.requestId !== pending.requestId) {
          return current;
        }
        return {
          ...current,
          bots: {
            ...current.bots,
            [context.botId]: { ...entry, pendingElicitation: undefined, updatedAt: this.now() },
          },
        };
      });
    }
    if (!hook) return;
    // payload 取清前读到的 pending（官方 `Ur=I.pendingElicitation` 同一引用，$e 不改内存对象）
    const outbound = pending
      ? createCompletedElicitationOutbound(actor, pending, locale, "cancel")
      : createOutbound(
          actor,
          event.type === "task_error"
            ? formatBotMessage(locale, "taskFailed", {
                message: (event as { error?: string }).error ?? "",
              })
            : formatBotMessage(locale, "received"),
          undefined,
          { locale },
        );
    await hook({ bot, actor, taskId, outbound });
  }

  /** watchTaskStream（tS）：订阅 onDynamicTaskEvent，按 replyMode 渲染回发；返回退订句柄。 */
  watchTaskStream(params: WatchTaskStreamParams): { dispose: () => void } {
    const { bot, actor, context, locale } = params;
    const mode: ReplyMode = params.forceMode ?? bot.replyMode;
    const parts: BotReplyPart[] = [];
    let buffer = "";
    let sentAnything = false;
    const seenToolIds = new Set<string>();
    const toolCalls = new Map<string, BotReplyToolCall>();
    const terminalSent = new Set<string>();
    const renderContext = { workspacePath: context.workspacePath, locale };
    let stopTyping = this.startTyping(bot, actor, params.taskId);
    const streamingSender =
      mode === "streaming_card"
        ? (this.options.createStreamingSender?.({
            bot,
            providerUserId: actor.chatId ?? actor.providerUserId,
            locale,
          }) ?? null)
        : null;

    const send = async (text: string): Promise<void> => {
      sentAnything = true;
      await this.options.sendOutbound(bot, {
        botId: bot.id,
        provider: bot.provider as OutboundMessage["provider"],
        providerUserId: actor.chatId ?? actor.providerUserId,
        text,
        locale,
        ...(actor.providerContextToken
          ? { providerContextToken: actor.providerContextToken }
          : {}),
      });
    };

    const flushBuffer = (force = false): void => {
      if (mode === "summary_changes") return;
      const { messages, rest } = extractBotAssistantResponseMessages(buffer, force);
      buffer = rest;
      for (const message of messages) {
        void send(message);
      }
    };

    let disposed = false;
    let eventQueue: Promise<void> = Promise.resolve();
    let registrationId: number | undefined;
    // 终态收口：释放流订阅 + typing 登记（官方 tS 终态 dispose 语义，防 R13 残留）
    const releaseRegistration = (): void => {
      if (registrationId === undefined) return;
      const id = registrationId;
      registrationId = undefined;
      this.options.resourceRegistry.release(id);
    };

    const handleEvent = async (event: BotTaskStreamEvent): Promise<void> => {
      await this.broadcastTaskStream(context, params.taskId, event).catch(() => undefined);
      this.updateLiveStatusProgress(params.taskId, event);
      if (event.type === "task_stream_mirror_batch") {
        for (const op of (event as { ops?: Array<{ kind?: string; event?: BotTaskStreamEvent }> }).ops ?? []) {
          if (op.kind === "stream_event" && op.event) await handleEvent(op.event);
        }
        return;
      }
      switch (event.type) {
        case "agent_message_chunk": {
          parts.push({ type: "content", content: event.content });
          if (streamingSender) {
            sentAnything = true;
            streamingSender.handleMessageChunk(event.content);
            await streamingSender.sync(event.type);
            return;
          }
          if (mode !== "summary_changes") {
            buffer += event.content;
            flushBuffer(false);
          }
          return;
        }
        case "agent_thought_chunk":
          parts.push({ type: "thought", content: event.content });
          return;
        case "tool_call":
        case "tool_call_update": {
          if (streamingSender) {
            sentAnything = true;
            updateToolCalls(toolCalls, event);
            streamingSender.handleTool(event.toolId);
            const toolCall = toolCalls.get(event.toolId);
            if (toolCall) {
              streamingSender.setToolSummaries(
                event.toolId,
                formatBotToolCallSummaryLine(toolCall, renderContext),
              );
            }
            await streamingSender.sync(event.type, event.type === "tool_call_update" && isBotToolCallReplyTerminal((event as { status?: string }).status as never));
            return;
          }
          flushBuffer(true);
          if (!seenToolIds.has(event.toolId)) {
            seenToolIds.add(event.toolId);
            parts.push({ type: "tool-call", toolId: event.toolId });
          }
          updateToolCalls(toolCalls, event);
          if (
            event.type === "tool_call_update" &&
            mode === "assistant_toolcalls_changes" &&
            isBotToolCallReplyTerminal(event.status) &&
            !terminalSent.has(event.toolId)
          ) {
            const toolCall = toolCalls.get(event.toolId);
            if (toolCall) {
              terminalSent.add(event.toolId);
              sentAnything = true;
              await send(formatBotToolCallReply(toolCall, renderContext));
            }
          }
          return;
        }
        case "permission_request": {
          stopTyping();
          await streamingSender?.seal();
          await this.broadcastTaskChange(context, params.taskId, "permission_request", {
            permissionRequest: event,
          });
          const localeNow = locale;
          const { selection, pendingOptions } = createPermissionSelection(
            {
              requestId: event.requestId,
              title: event.title,
              description: event.description,
              kind: event.kind,
              raw: event.raw,
            },
            event.options,
            { workspacePath: context.workspacePath, locale: localeNow },
          );
          await this.options.repo.updateState((state) => ({
            ...state,
            bots: {
              ...state.bots,
              [context.botId]: {
                ...context,
                pendingPermissionOptions: pendingOptions.map((option) => ({
                  ...option,
                  response: option.response,
                })),
                updatedAt: this.now(),
              },
            },
          }));
          await this.options.sendOutbound(
            bot,
            {
              botId: bot.id,
              provider: bot.provider as OutboundMessage["provider"],
              providerUserId: actor.chatId ?? actor.providerUserId,
              text: selection.title,
              selection,
              locale,
            },
            { taskId: params.taskId },
          );
          return;
        }
        case "elicitation_request": {
          stopTyping();
          await streamingSender?.seal();
          const request = event as unknown as ElicitationRequestLike;
          const questions = normalizeBotElicitationQuestions(request, locale);
          const renderCtx = readBotElicitationRenderContext(request);
          const pending = {
            taskId: request.taskId,
            requestId: request.requestId,
            runId: request.traceId,
            ...(request.origin ? { origin: request.origin } : {}),
            actorKey: getActorKey(actor),
            currentQuestionIndex: 0,
            questions,
            answers: {},
            ...(renderCtx ? { renderContext: toPendingElicitationRenderContext(renderCtx) } : {}),
          };
          await this.options.repo.updateState((state) => ({
            ...state,
            bots: {
              ...state.bots,
              [context.botId]: { ...context, pendingElicitation: pending, updatedAt: this.now() },
            },
          }));
          // R13：pending elicitation 入登记表（dispose 守卫 requestId+题序，不误清 advance 后的状态）
          this.options.resourceRegistry.registerScoped(
            context.botId,
            `elicitation:${pending.requestId}`,
            {
              dispose: () =>
                void this.options.repo.updateState((state) => {
                  const botState = state.bots[context.botId];
                  const current = botState?.pendingElicitation;
                  if (
                    !botState ||
                    current?.requestId !== pending.requestId ||
                    current?.currentQuestionIndex !== pending.currentQuestionIndex
                  ) {
                    return state;
                  }
                  return {
                    ...state,
                    bots: {
                      ...state.bots,
                      [context.botId]: {
                        ...botState,
                        pendingElicitation: undefined,
                        updatedAt: this.now(),
                      },
                    },
                  };
                }),
            },
            params.taskId,
          );
          await this.broadcastTaskChange(context, params.taskId, "elicitation_request", {
            elicitationRequest: createBotElicitationRequestSnapshot(pending),
            requestId: pending.requestId,
          });
          const selection = createBotElicitationSelection(pending, locale);
          await this.options.sendOutbound(
            bot,
            {
              botId: bot.id,
              provider: bot.provider as OutboundMessage["provider"],
              providerUserId: actor.chatId ?? actor.providerUserId,
              text: selection.title,
              selection,
              elicitation: createElicitationView(pending, "pending"),
              locale,
            },
            { taskId: request.taskId },
          );
          return;
        }
        case "elicitation_response": {
          this.options.resourceRegistry.releaseScoped(
            context.botId,
            `elicitation:${event.requestId}`,
          );
          await this.options.repo.updateState((state) => {
            const current = state.bots[context.botId];
            if (!current?.pendingElicitation) return state;
            const bots = { ...state.bots };
            delete bots[context.botId];
            return {
              ...state,
              bots: {
                ...bots,
                [context.botId]: {
                  ...current,
                  pendingElicitation: undefined,
                  updatedAt: this.now(),
                },
              },
            };
          });
          await this.broadcastTaskChange(context, params.taskId, "elicitation_resolved", {
            requestId: event.requestId,
          });
          return;
        }
        case "task_complete":
        case "task_error": {
          this.markTaskFinished(event.taskId ?? params.taskId);
          stopTyping();
          releaseRegistration();
          // 终态 transient 卡收口（官方 tS task_complete/task_error 的 Mt 调用）：见 finalizeTransientAtTaskEnd
          await this.finalizeTransientAtTaskEnd(params, event).catch(() => undefined);
          const isError = event.type === "task_error";
          await this.broadcastTaskChange(context, params.taskId, isError ? "error" : "completed", isError ? { error: (event as { error?: string }).error ?? "" } : {});
          if (isError) {
            const message = (event as { error?: string }).error ?? "";
            const text = formatBotMessage(locale, "taskFailed", { message });
            if (streamingSender) {
              streamingSender.setStatus("error");
              if (!streamingSender.active) streamingSender.handleMessageChunk(text);
              await streamingSender.sync(event.type, true);
            } else {
              await send(text);
            }
            disposed = true;
            return;
          }
          flushBuffer(true);
          const summary = readTurnChangeSummaryFromTools(parts, toolCalls, context.workspacePath);
          const blocks = createAssistantReplyBlocks(parts, toolCalls, mode, summary);
          const messages = blocksToMessages(blocks, renderContext);
          if (streamingSender) {
            if (messages.length > 0) {
              streamingSender.handleMessageChunk(`\n\n${messages.join("\n\n")}`);
            }
            streamingSender.setStatus("completed");
            await streamingSender.sync(event.type, true);
            disposed = true;
            return;
          }
          if (messages.length === 0 && !sentAnything) {
            await send(locale === "en-US" ? "Task completed." : "任务已完成。");
            disposed = true;
            return;
          }
          for (const message of messages) await send(message);
          disposed = true;
          return;
        }
        default:
          return;
      }
    };

    const handler = (event: ZCodeStreamEvent): void => {
      // 事件串行入队（oT 语义），避免并发处理交错状态
      eventQueue = eventQueue.then(() => handleEvent(event as unknown as BotTaskStreamEvent));
      eventQueue = eventQueue.catch((error: unknown) => {
        this.options.logger.warn(
          undefined,
          `bot task stream event failed task=${params.taskId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    };

    const subscription = this.options.taskService.onDynamicTaskEvent({
      workspacePath: context.workspacePath,
      ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
      taskId: params.taskId,
      deliveryKind: "continuous",
    })(handler);

    registrationId = this.options.resourceRegistry.register(
      bot.id,
      {
        unsubscribe: () => subscription.dispose(),
        stopTyping: () => stopTyping(),
      },
      params.taskId,
    );
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        releaseRegistration();
      },
    };
  }
}

function updateToolCalls(
  toolCalls: Map<string, BotReplyToolCall>,
  event: BotTaskStreamEvent & { type: "tool_call" | "tool_call_update" },
): void {
  if (event.type === "tool_call") {
    toolCalls.set(event.toolId, {
      toolId: event.toolId,
      parentToolUseId: event.parentToolUseId ?? null,
      title: event.title,
      kind: event.kind,
      input: event.input,
      raw: event.raw,
      status: "pending",
    });
    return;
  }
  const existing = toolCalls.get(event.toolId) ?? {
    toolId: event.toolId,
    title: event.title ?? "",
    status: event.status,
    raw: event.raw,
  };
  toolCalls.set(event.toolId, {
    ...existing,
    parentToolUseId: event.parentToolUseId ?? existing.parentToolUseId ?? null,
    title: event.title ?? existing.title,
    toolName: event.toolName ?? existing.toolName,
    kind: event.kind ?? existing.kind,
    input: event.input ?? existing.input,
    output: event.content ?? existing.output,
    status: event.status,
    error: event.error ?? existing.error,
    raw: event.raw ?? existing.raw,
  });
}

/**
 * readLatestTaskProgress（tH）：任务快照兜底进展。
 * 末条 assistant 消息的 parts 逆序找首个非空 content/thought（vI 180 截断）或 tool-call 对应工具行（qZ）；
 * parts 无果则回落消息级 content/thought/末个工具行；全空返回 null。
 */
export function readLatestTaskProgress(
  snapshot: Pick<ZCodeTaskSnapshot, "messages"> | null | undefined,
): string | null {
  const messages = snapshot?.messages ?? [];
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    for (const part of [...(message.parts ?? [])].reverse()) {
      if ((part.type === "content" || part.type === "thought") && part.content.trim()) {
        return truncateStatusProgressText(normalizeInlineText(part.content));
      }
      if (part.type === "tool-call") {
        const line = formatStatusToolProgress(
          message.tools?.[part.toolIndex] as BotStreamToolProgressLike | undefined,
        );
        if (line) return truncateStatusProgressText(line);
      }
    }
    const fallback =
      readStatusStringField(message.content, []) ??
      readStatusStringField(message.thought, []) ??
      formatStatusToolProgress(message.tools?.at(-1) as BotStreamToolProgressLike | undefined);
    if (fallback) return truncateStatusProgressText(fallback);
  }
  return null;
}

/** XZ 简化：从本轮 edit 类工具的 before/after 内容聚合变更摘要；无快照时返回 null。 */
export function readTurnChangeSummaryFromTools(
  parts: readonly BotReplyPart[],
  toolCalls: ReadonlyMap<string, BotReplyToolCall>,
  workspacePath: string,
): BotChangeSummary | null {
  const snapshots: BotTurnFileSnapshot[] = [];
  for (const toolCall of toolCalls.values()) {
    if (toolCall.kind !== "edit" && toolCall.kind !== "write") continue;
    const input = (typeof toolCall.input === "object" && toolCall.input !== null
      ? toolCall.input
      : {}) as Record<string, unknown>;
    const output = (typeof toolCall.output === "object" && toolCall.output !== null
      ? toolCall.output
      : {}) as Record<string, unknown>;
    const path =
      typeof input.path === "string"
        ? input.path
        : typeof input.file_path === "string"
          ? input.file_path
          : typeof output.path === "string"
            ? output.path
            : undefined;
    if (!path) continue;
    const beforeContent = typeof input.old_string === "string" ? input.old_string : "";
    const afterContent =
      typeof input.new_string === "string"
        ? input.new_string
        : typeof input.content === "string"
          ? input.content
          : "";
    snapshots.push({ path, beforeContent, afterContent, writeCount: 1 });
  }
  if (snapshots.length === 0) return null;
  void parts;
  void workspacePath;
  const summaries = buildPerTurnChangeSummaries([{ turnIndex: 0, snapshots }]);
  return summaries.get(0) ?? null;
}
