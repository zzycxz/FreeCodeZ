// 消息 → 任务流（附录B §2.7 G4 handleMessage）：
// deletedTaskReplaced → elicitation 文本拦截 → 任务运行中拒绝 → 附件落盘拼 prompt →
// 建任务（强制 yolo）或续任务 → watchTaskStream → prompt_sent → sendPromptInBackground。
// 成功返回 []（回发由任务流产出）；模型不可用抛 sessionModelUnavailable / Submission 解析错误。
import { randomUUID } from "node:crypto";
import type { BotActor, BotConfig, BotContext, InboundMessage, OutboundMessage } from "@zcode/shared/bots";
import { formatBotMessage, type BotHostLocale } from "./hostMessages.js";
import { createOutbound, handlePendingElicitationText, type BotCommandDeps } from "./commandHandlers.js";
import { prepareBotMessageContent, formatAttachmentRejectedReason } from "./attachments.js";
import type { BotAttachmentDeps } from "./attachments.js";

export function createTraceIdForPrompt(): string {
  return randomUUID();
}

function deriveTaskTitle(content: string): string | undefined {
  const line = content
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  return line ? line.slice(0, 80) : undefined;
}

export interface MessageFlowDeps extends BotCommandDeps {
  attachments: BotAttachmentDeps;
}

export interface MessageFlowScope {
  deps: MessageFlowDeps;
  bot: BotConfig;
  actor: BotActor;
  context: BotContext;
  locale: BotHostLocale;
  /** withAuthorizedContext 已通过（message family）。 */
  authorized: true;
}

/** handleMessage（G4）主流程。 */
export async function handleMessageTaskFlow(
  scope: MessageFlowScope,
  message: InboundMessage,
): Promise<OutboundMessage[]> {
  const { deps, bot, actor, locale } = scope;
  let context = scope.context;

  // deletedTaskReplaced（§6.6）：任务已删 → 重建草稿、新任务处理、先回提示
  let replacedTaskId: string | null = null;
  if (context.mode === "task" && context.activeTaskId) {
    const deleted = await deps.taskBridge.listDeletedTaskIdsSafe({ context });
    if (deleted.includes(context.activeTaskId)) {
      replacedTaskId = context.activeTaskId;
      context = await deps.writeDraftContext(context);
    }
  }

  // 待回答卷文本拦截（F4）：有 pendingElicitation 时文本即答案
  const elicitationReplies = await handlePendingElicitationText(
    { deps, bot, actor, context, locale },
    message.text,
  );
  if (elicitationReplies) return elicitationReplies;

  if (
    context.mode === "task" &&
    context.activeTaskId &&
    deps.taskBridge.isTaskRunning(context.activeTaskId)
  ) {
    return [createOutbound(actor, formatBotMessage(locale, "taskRunning"), undefined, { locale })];
  }

  let prepared;
  try {
    prepared = await prepareBotMessageContent(deps.attachments, bot.id, message, locale);
  } catch (error) {
    return [
      createOutbound(
        actor,
        formatBotMessage(locale, "attachmentRejected", {
          message: formatAttachmentRejectedReason(error, locale),
        }),
        undefined,
        { locale },
      ),
    ];
  }

  const traceId = createTraceIdForPrompt();
  const promptPayload = {
    content: prepared.content,
    ...(prepared.zcodeAttachments.length > 0 ? { attachments: prepared.zcodeAttachments } : {}),
    messageId: `bot-${traceId}`,
    sentAt: deps.now(),
  };

  if (context.mode === "draft" || !context.activeTaskId) {
    const draftOptions = context.draftOptions ?? { provider: "glm" as const };
    const resolution = await deps.resolveModelSelection(context, draftOptions.modelSelection);
    const modelSelection = draftOptions.modelSelection
      ? resolution.effectiveSelection
      : (resolution.preferredSelection ?? resolution.effectiveSelection);
    if (!modelSelection || (draftOptions.modelSelection && resolution.selectionIssue)) {
      throw new Error("Bot 无法从目标 Host 解析 Submission 模型");
    }
    const task = await deps.taskBridge.createBotTask({ context, modelSelection });
    const title = deriveTaskTitle(prepared.content);
    const taskForBroadcast = title ? { ...task, title } : task;
    try {
      await deps.writeContext({
        ...context,
        draftOptions: { provider: "glm", modelSelection },
      });
    } catch (error) {
      await deps.taskBridge
        .deleteTaskSafe({ context, taskId: task.taskId })
        .catch(() => undefined);
      throw error;
    }
    const activeContext: BotContext = {
      ...context,
      mode: "task",
      activeTaskId: task.taskId,
      draftOptions: undefined,
    };
    await deps.writeContext(activeContext);
    await deps.taskBridge.broadcastTaskChange(activeContext, task.taskId, "created", {
      task: taskForBroadcast,
    });
    if (replacedTaskId) {
      await deps.sendOutbound(
        bot,
        createOutbound(actor, formatBotMessage(locale, "deletedTaskReplaced"), undefined, { locale }),
      );
    }
    deps.taskBridge.watchTaskStream({
      bot,
      actor,
      context: activeContext,
      locale,
      taskId: task.taskId,
    });
    await deps.taskBridge.broadcastTaskChange(activeContext, task.taskId, "prompt_sent", {
      task: taskForBroadcast,
      prompt: promptPayload,
    });
    deps.taskBridge.sendPromptInBackground({
      bot,
      actor,
      context: activeContext,
      taskId: task.taskId,
      traceId,
      content: prepared.content,
      attachments: prepared.zcodeAttachments,
      modelSelection,
    });
    return [];
  }

  // 续任务路径
  await deps.taskBridge.resumeBotTask({ context, taskId: context.activeTaskId });
  const taskModelSelection = await deps.taskBridge.getTaskModelSelectionSafe(context.activeTaskId);
  const resolution = await deps.resolveModelSelection(context, taskModelSelection ?? undefined);
  const effective = resolution.effectiveSelection;
  if (!effective || resolution.selectionIssue) {
    throw new Error(formatBotMessage(locale, "sessionModelUnavailable"));
  }
  await deps.taskBridge.broadcastTaskChange(context, context.activeTaskId, "resumed");
  deps.taskBridge.watchTaskStream({
    bot,
    actor,
    context,
    locale,
    taskId: context.activeTaskId,
  });
  await deps.taskBridge.broadcastTaskChange(context, context.activeTaskId, "prompt_sent", {
    prompt: promptPayload,
  });
  deps.taskBridge.sendPromptInBackground({
    bot,
    actor,
    context,
    taskId: context.activeTaskId,
    traceId,
    content: prepared.content,
    attachments: prepared.zcodeAttachments,
    modelSelection: effective,
  });
  void message;
  return [];
}

export type { BotAttachmentDeps };
