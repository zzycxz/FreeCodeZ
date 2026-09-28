// 命令 → 回复矩阵（附录B §1.5）+ elicitation 状态机驱动（§2.3 L4/Xd/os/F4）。
// 命令策略：help/message/approve/task/stop 恒允许；reconnect 看 allowedCommands.workspace；
// 其余看同名键 !== false；bind 无私聊策略门控（自带私聊门禁）。
/* eslint-disable max-lines -- 状态机构造/Selection 兜底/帮助与状态文本与 §1.5 驱动函数同属一个回复矩阵内聚单元，拆散会让对照附录B 终审更难追踪。 */
import {
  normalizeBotCommandPolicy,
  type BotActor,
  type BotConfig,
  type BotContext,
  type BotSelection,
  type OutboundMessage,
  type PendingElicitation,
} from "@zcode/shared/bots";
import { formatBotMessage, type BotHostLocale } from "./hostMessages.js";
import {
  formatSelectionFallback,
  formatStatusLine,
  formatStatusStateValue,
  formatTaskRunningDuration,
  markCurrentSelection,
  stripModelProviderDescriptionsForTextSelection,
} from "./replyPipeline.js";
import {
  buildBotElicitationContent,
  createBotElicitationSelection,
  createElicitationView,
  ELICITATION_CUSTOM_OPTION,
  ELICITATION_SUBMIT_OPTION,
  getElicitationAnswerKey,
  getPendingElicitationSkipOptionId,
  getPendingElicitationSelectionToken,
  isPendingElicitationOwnedByActor,
  mergeElicitationFormValues,
  parseElicitationFormValues,
  parseElicitationResponseValue,
  readElicitationAnswerValues,
  resolveElicitationQuestionValue,
  toggleElicitationCustomAnswerExpanded,
} from "./elicitation.js";
import type { BindCodeStore } from "./bindCodes.js";
import type { BotsRepo } from "./botsRepo.js";
import type { BotTaskBridge } from "./taskBridge.js";
import type { BotResourceRegistry } from "./resourceRegistry.js";
import type { BotWorkspaceRef } from "./bots.js";

export interface BotModelCatalogProvider {
  id: string;
  name: string;
  models: Array<{ id: string; name: string; thoughtLevels?: string[] }>;
}

export interface BotModelResolution {
  effectiveSelection: import("@zcode/shared").ModelSelection | null;
  preferredSelection?: import("@zcode/shared").ModelSelection | null;
  selectionIssue?: string;
}

export interface BotCommandDeps {
  repo: BotsRepo;
  bindCodes: BindCodeStore;
  taskBridge: BotTaskBridge;
  sendOutbound: (
    bot: BotConfig,
    outbound: OutboundMessage,
    options?: { taskId?: string },
  ) => Promise<void>;
  listWorkspaceRefs: () => Promise<BotWorkspaceRef[]>;
  listModelCatalog: () => Promise<BotModelCatalogProvider[]>;
  resolveModelSelection: (
    context: BotContext,
    requested?: import("@zcode/shared").ModelSelection,
  ) => Promise<BotModelResolution>;
  pendingSelections: Map<string, BotSelection>;
  now: () => number;
  /** 远端连接判定（无 remoteWorkspaceService 时视为本地/未连接）。 */
  isRemoteConnected?: (
    context: Pick<BotContext, "workspacePath" | "workspaceIdentity">,
  ) => Promise<boolean>;
  writeDraftContext: (
    context: BotContext,
    draftOptions?: BotContext["draftOptions"],
  ) => Promise<BotContext>;
  writeContext: (context: BotContext) => Promise<BotContext>;
  saveBotConfig: (bot: BotConfig) => Promise<BotConfig>;
  resolveLocale: () => Promise<BotHostLocale>;
  /** R13 任务级资源登记表：pending selection / pending elicitation 入表，三路径统一释放。 */
  resourceRegistry?: BotResourceRegistry;
}

export interface BotHandlerScope {
  deps: BotCommandDeps;
  bot: BotConfig;
  actor: BotActor;
  context: BotContext;
  locale: BotHostLocale;
}

export function createOutbound(
  actor: Pick<BotActor, "botId" | "provider" | "chatId" | "providerUserId" | "providerContextToken">,
  text: string,
  selection?: BotSelection,
  extra: Partial<OutboundMessage> = {},
): OutboundMessage {
  return {
    botId: actor.botId,
    provider: actor.provider as OutboundMessage["provider"],
    providerUserId: actor.chatId ?? actor.providerUserId,
    text,
    ...(selection ? { selection } : {}),
    ...extra,
    ...(actor.providerContextToken
      ? { providerContextToken: actor.providerContextToken }
      : {}),
  };
}

/** isUserCommandAllowed（$Z）：恒许 help/message/approve/task/stop；reconnect→workspace 键；其余同名键。 */
export function isUserCommandAllowed(
  user: Pick<BotConfig, "allowedCommands">,
  command: string,
): boolean {
  if (command === "help" || command === "message" || command === "approve" || command === "task" || command === "stop") {
    return true;
  }
  const policy = normalizeBotCommandPolicy(user.allowedCommands);
  if (command === "reconnect") return policy.workspace !== false;
  return (policy as Record<string, boolean | undefined>)[command] !== false;
}

/** createSelectionReply（fo）：非微信 text=标题+selection 入 pending；微信 formatSelectionFallback。 */
export async function createSelectionReply(
  scope: Pick<BotHandlerScope, "deps" | "actor" | "locale">,
  selection: BotSelection,
  extra: Partial<OutboundMessage> = {},
): Promise<OutboundMessage[]> {
  const { deps, actor, locale } = scope;
  const marked = markCurrentSelection(selection, locale);
  const isWeixin = actor.provider === "weixin";
  const resolved = isWeixin
    ? { ...stripModelProviderDescriptionsForTextSelection(marked), cancelLabel: marked.cancelLabel }
    : marked;
  const actorKey = [actor.botId, actor.provider, actor.chatId ?? actor.providerUserId].join("::");
  deps.pendingSelections.set(actorKey, resolved);
  // R13：pending selection 入登记表（dispose 带比对守卫，避免误删后续新选择）
  deps.resourceRegistry?.registerScoped(actor.botId, `selection:${actorKey}`, {
    dispose: () => {
      if (deps.pendingSelections.get(actorKey) === resolved) deps.pendingSelections.delete(actorKey);
    },
  });
  const text = isWeixin ? formatSelectionFallback(resolved, locale) : resolved.title;
  return [
    createOutbound(actor, text, isWeixin ? undefined : resolved, { ...extra, locale }),
  ];
}

export function clearPendingSelection(
  deps: BotCommandDeps,
  actor: Pick<BotActor, "botId" | "provider" | "chatId" | "providerUserId">,
): void {
  const actorKey = [actor.botId, actor.provider, actor.chatId ?? actor.providerUserId].join("::");
  deps.pendingSelections.delete(actorKey);
  deps.resourceRegistry?.releaseScoped(actor.botId, `selection:${actorKey}`);
}

export function buildHelpText(locale: BotHostLocale, bot: BotConfig): string {
  const order = [
    "help",
    "status",
    "new",
    "workspace",
    "model",
    "mode",
    "thoughtLevel",
    "reply",
    "bind",
  ] as const;
  const keyMap = {
    help: "helpHelp",
    status: "helpStatus",
    new: "helpNew",
    workspace: "helpWorkspace",
    model: "helpModel",
    mode: "helpMode",
    thoughtLevel: "helpThoughtLevel",
    reply: "helpReply",
    bind: "helpBind",
  } as const;
  const lines = [formatBotMessage(locale, "helpTitle")];
  for (const name of order) {
    if (name === "help" || name === "bind") {
      lines.push(formatBotMessage(locale, keyMap[name]));
      continue;
    }
    if (isUserCommandAllowed(bot, name)) lines.push(formatBotMessage(locale, keyMap[name]));
  }
  return lines.join("\n");
}

export async function buildStatusText(scope: BotHandlerScope): Promise<string> {
  const { deps, context, locale } = scope;
  const refs = await deps.listWorkspaceRefs();
  const ref = refs.find((candidate) => candidate.id === context.workspaceId);
  const workspaceLabel = ref?.label ?? context.workspacePath;
  // 远端断连短路版（eT `!(await vt(h))` 分支）
  const connected = context.workspaceIdentity
    ? ((await deps.isRemoteConnected?.(context)) ?? false)
    : true;
  const modelLabel =
    context.draftOptions?.modelSelection
      ? `${context.draftOptions.modelSelection.providerId}/${context.draftOptions.modelSelection.modelId}`
      : "-";
  if (!connected) {
    return [
      formatStatusLine(locale, "statusWorkspace", workspaceLabel),
      formatStatusLine(locale, "statusModel", modelLabel),
      "------",
      formatStatusLine(locale, "statusTask", context.activeTaskId ?? formatBotMessage(locale, "statusDraft")),
      formatStatusLine(locale, "statusState", formatStatusStateValue(locale, "remote disconnected")),
      formatBotMessage(locale, "remoteDisconnectedStatus", {
        workspacePath: context.workspacePath,
      }),
    ].join("\n");
  }
  const lines = [formatStatusLine(locale, "statusWorkspace", workspaceLabel)];
  lines.push(formatStatusLine(locale, "statusModel", modelLabel));
  lines.push("------");
  if (context.mode === "draft" || !context.activeTaskId) {
    lines.push(formatStatusLine(locale, "statusTask", formatBotMessage(locale, "statusDraft")));
    lines.push(formatStatusLine(locale, "statusState", formatStatusStateValue(locale, "draft")));
    return lines.join("\n");
  }
  const meta = await deps.taskBridge
    .getTaskMetaSafe({ taskId: context.activeTaskId, context })
    .catch(() => null);
  lines.push(
    formatStatusLine(
      locale,
      "statusTask",
      meta ? `${meta.title} (${meta.taskId})` : (context.activeTaskId ?? "-"),
    ),
  );
  const running = deps.taskBridge.isTaskRunning(context.activeTaskId);
  lines.push(
    formatStatusLine(
      locale,
      "statusState",
      formatStatusStateValue(
        locale,
        running ? "running" : meta?.status === "error" ? "error" : "completed",
      ),
    ),
  );
  // [已工作: 1d 2h 3m 4s]（§2.6）：任务运行耗时，天/时/分/秒按需出现；拿不到耗时省略
  const worked = deps.taskBridge.readTaskWorkedDurationMs(context.activeTaskId, meta);
  if (worked !== null) {
    lines.push(formatStatusLine(locale, "statusWorked", formatTaskRunningDuration(worked)));
  }
  // [进展]（官方 eT `ge=activeTaskId&&(!ce||ap(ce)==="running")?p.get(taskId)?.text??tH(V):null`）：
  // 仅运行中显示（meta 缺失或 status??running 即视为运行中）；取值=实时登记优先、任务快照 tH 兜底
  const taskStatus = meta?.status ?? "running";
  const progress =
    context.activeTaskId && (!meta || taskStatus === "running")
      ? ((deps.taskBridge.getTaskLiveStatusProgress(context.activeTaskId) ??
          (await deps.taskBridge.readTaskSnapshotProgressSafe({
            taskId: context.activeTaskId,
            context,
          }))) ??
        null)
      : null;
  if (progress) {
    lines.push(formatStatusLine(locale, "statusProgress", progress));
  }
  return lines.join("\n");
}

/**
 * createCompletedElicitationOutbound（eS）：收口用完成/取消问答卡。
 * `cancel` → status "cancelled"、题序推到末题（createElicitationView 非 pending 语义），文本 elicitationCancelled。
 */
export function createCompletedElicitationOutbound(
  actor: Pick<BotActor, "botId" | "provider" | "chatId" | "providerUserId" | "providerContextToken">,
  pending: PendingElicitation,
  locale: BotHostLocale,
  action: "accept" | "cancel",
): OutboundMessage {
  return createOutbound(
    actor,
    formatBotMessage(
      locale,
      action === "accept" ? "elicitationSubmitted" : "elicitationCancelled",
    ),
    undefined,
    {
      locale,
      elicitation: createElicitationView(
        pending,
        action === "cancel" ? "cancelled" : "completed",
      ),
    },
  );
}

// ── elicitation 状态机驱动 ──

async function persistPendingElicitation(
  scope: BotHandlerScope,
  pending: PendingElicitation | undefined,
): Promise<void> {
  await scope.deps.repo.updateState((state) => ({
    ...state,
    bots: {
      ...state.bots,
      [scope.bot.id]: {
        ...scope.context,
        pendingElicitation: pending,
        updatedAt: scope.deps.now(),
      },
    },
  }));
  // R13：pending elicitation 入/出登记表（收口即自注销；dispose 只清同 requestId 的残留）
  const { resourceRegistry } = scope.deps;
  if (!resourceRegistry) return;
  const previous = scope.context.pendingElicitation;
  if (previous) resourceRegistry.releaseScoped(scope.bot.id, `elicitation:${previous.requestId}`);
  if (pending) {
    resourceRegistry.registerScoped(
      scope.bot.id,
      `elicitation:${pending.requestId}`,
      {
        // 守卫含题序：advance 后旧登记 dispose 不得误清新状态
        dispose: () =>
          void scope.deps.repo.updateState((state) => {
            const botState = state.bots[scope.bot.id];
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
                [scope.bot.id]: {
                  ...botState,
                  pendingElicitation: undefined,
                  updatedAt: scope.deps.now(),
                },
              },
            };
          }),
      },
      pending.taskId,
    );
  }
}

async function sendElicitationSelection(
  scope: BotHandlerScope,
  pending: PendingElicitation,
): Promise<OutboundMessage[]> {
  const selection = createBotElicitationSelection(pending, scope.locale);
  return [
    createOutbound(scope.actor, selection.title, selection, {
      elicitation: createElicitationView(pending, "pending"),
      locale: scope.locale,
    }),
  ];
}

export async function submitPendingElicitation(
  scope: BotHandlerScope,
  pending: PendingElicitation,
  action: "accept" | "decline" | "cancel",
  content?: Record<string, unknown>,
): Promise<OutboundMessage[]> {
  const { deps, actor, context, locale } = scope;
  if (pending.actorKey && pending.actorKey !== [actor.botId, actor.provider, actor.chatId ?? actor.providerUserId].join("::")) {
    return [createOutbound(actor, formatBotMessage(locale, "elicitationExpired"), undefined, { locale })];
  }
  if (pending.handledAt) {
    return [createOutbound(actor, formatBotMessage(locale, "elicitationHandled"), undefined, { locale })];
  }
  const ok = await deps.taskBridge.respondElicitationSafe({
    context,
    taskId: pending.taskId,
    runId: pending.runId,
    requestId: pending.requestId,
    action,
    ...(content ? { content } : {}),
  });
  await persistPendingElicitation(scope, undefined);
  await deps.taskBridge.broadcastTaskChange(context, pending.taskId, "elicitation_resolved", {
    requestId: pending.requestId,
  });
  if (!ok) {
    return [createOutbound(actor, formatBotMessage(locale, "elicitationHandled"), undefined, { locale })];
  }
  const status = action === "accept" ? "completed" : "cancelled";
  return [
    createOutbound(
      actor,
      formatBotMessage(locale, action === "accept" ? "elicitationSubmitted" : "elicitationCancelled"),
      undefined,
      {
        locale,
        elicitation: createElicitationView({ ...pending, handledAt: deps.now() }, status),
      },
    ),
  ];
}

async function advancePendingElicitation(
  scope: BotHandlerScope,
  pending: PendingElicitation,
  answers: Record<string, string[]>,
): Promise<OutboundMessage[]> {
  if (pending.currentQuestionIndex >= pending.questions.length - 1) {
    return submitPendingElicitation(
      scope,
      { ...pending, answers },
      "accept",
      buildBotElicitationContent(pending, answers),
    );
  }
  const next: PendingElicitation = {
    ...pending,
    currentQuestionIndex: pending.currentQuestionIndex + 1,
    answers,
  };
  await persistPendingElicitation(scope, next);
  await scope.deps.taskBridge.broadcastTaskChange(scope.context, next.taskId, "elicitation_request", {
    elicitationRequest: next,
    requestId: next.requestId,
  });
  return sendElicitationSelection(scope, next);
}

/** handlePendingElicitationValue（L4）：token 校验 → skip/form/custom/toggle/advance。 */
export async function handlePendingElicitationValue(
  scope: BotHandlerScope,
  value: string,
): Promise<OutboundMessage[]> {
  const { actor, context, locale } = scope;
  const pending = context.pendingElicitation;
  const expired = [createOutbound(actor, formatBotMessage(locale, "elicitationExpired"), undefined, { locale })];
  if (!pending || pending.taskId !== context.activeTaskId) return expired;
  if (!isPendingElicitationOwnedByActor(pending, actor)) return expired;
  const question = pending.questions[pending.currentQuestionIndex];
  if (!question) return expired;
  const parsed = parseElicitationResponseValue(value);
  if (actor.provider !== "weixin") {
    const token = getPendingElicitationSelectionToken(pending);
    if (!parsed.token || parsed.token !== token) return expired;
  }
  const skipId = getPendingElicitationSkipOptionId(pending);
  if (parsed.value === skipId) {
    return advancePendingElicitation(scope, pending, pending.answers);
  }
  const formValues = parseElicitationFormValues(parsed.value);
  if (formValues) {
    const key = getElicitationAnswerKey(pending.currentQuestionIndex);
    const merged = mergeElicitationFormValues(
      question,
      readElicitationAnswerValues(pending, pending.currentQuestionIndex),
      formValues,
    );
    if (merged.length === 0) return sendElicitationSelection(scope, pending);
    return advancePendingElicitation(scope, pending, { ...pending.answers, [key]: merged });
  }
  const resolved = resolveElicitationQuestionValue(question, parsed.value);
  if (!resolved) return sendElicitationSelection(scope, pending);
  if (resolved === ELICITATION_SUBMIT_OPTION) {
    return advancePendingElicitation(scope, pending, pending.answers);
  }
  if (resolved === ELICITATION_CUSTOM_OPTION) {
    const next = {
      ...pending,
      expandedCustomAnswerQuestionIndexes: toggleElicitationCustomAnswerExpanded(
        pending,
        pending.currentQuestionIndex,
      ),
    };
    await persistPendingElicitation(scope, next);
    return sendElicitationSelection(scope, next);
  }
  const key = getElicitationAnswerKey(pending.currentQuestionIndex);
  if (question.multiSelect) {
    const current = readElicitationAnswerValues(pending, pending.currentQuestionIndex);
    const nextValues = current.includes(resolved)
      ? current.filter((item) => item !== resolved)
      : [...current, resolved];
    const next: PendingElicitation = {
      ...pending,
      answers: { ...pending.answers, [key]: nextValues },
    };
    await persistPendingElicitation(scope, next);
    return sendElicitationSelection(scope, next);
  }
  return advancePendingElicitation(scope, pending, { ...pending.answers, [key]: [resolved] });
}

/** handlePendingElicitationText（F4）：多选按 [,\n，、] 切分；单选末项序号=跳过。 */
export async function handlePendingElicitationText(
  scope: BotHandlerScope,
  text: string,
): Promise<OutboundMessage[] | null> {
  const { actor, context, locale } = scope;
  const pending = context.pendingElicitation;
  if (!pending || pending.taskId !== context.activeTaskId) return null;
  if (!isPendingElicitationOwnedByActor(pending, actor)) return null;
  const trimmed = text.trim();
  if (!trimmed) return sendElicitationSelection(scope, pending);
  if (trimmed === getPendingElicitationSkipOptionId(pending)) {
    return advancePendingElicitation(scope, pending, pending.answers);
  }
  const key = getElicitationAnswerKey(pending.currentQuestionIndex);
  const question = pending.questions[pending.currentQuestionIndex];
  if (!question) {
    return [createOutbound(actor, formatBotMessage(locale, "elicitationExpired"), undefined, { locale })];
  }
  if (
    !question.multiSelect &&
    /^[1-9]\d*$/u.test(trimmed) &&
    Number.parseInt(trimmed, 10) === question.options.length + 1
  ) {
    return advancePendingElicitation(scope, pending, pending.answers);
  }
  const values = question.multiSelect
    ? trimmed
        .split(/[,\n，、]/u)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => resolveElicitationQuestionValue(question, part, { includeSubmit: false }))
    : [resolveElicitationQuestionValue(question, trimmed, { includeSubmit: false })];
  return advancePendingElicitation(scope, pending, { ...pending.answers, [key]: values });
}

/** handleSelectionCancel（z4）：pending elicitation → cancel；无 pending 而有 pendingElicitation → cancel；裸 "0" → unknownCommand("0")；清普通 pending → 状态文本。 */
export async function handleSelectionCancel(
  scope: BotHandlerScope,
): Promise<OutboundMessage[]> {
  const { deps, actor, context, locale } = scope;
  const actorKey = [actor.botId, actor.provider, actor.chatId ?? actor.providerUserId].join("::");
  const pendingSelection = deps.pendingSelections.get(actorKey);
  const pendingElicitation = context.pendingElicitation;
  if (pendingSelection?.action === "elicitation.respond") {
    if (pendingElicitation) {
      clearPendingSelection(deps, actor);
      return submitPendingElicitation(scope, pendingElicitation, "cancel");
    }
    clearPendingSelection(deps, actor);
    return [createOutbound(actor, formatBotMessage(locale, "elicitationExpired"), undefined, { locale })];
  }
  if (!pendingSelection) {
    if (pendingElicitation) return submitPendingElicitation(scope, pendingElicitation, "cancel");
    return [
      createOutbound(
        actor,
        formatBotMessage(locale, "unknownCommand", { command: "0" }),
        undefined,
        { locale },
      ),
    ];
  }
  clearPendingSelection(deps, actor);
  return [createOutbound(actor, await buildStatusText(scope), undefined, { locale })];
}
