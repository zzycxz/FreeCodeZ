// 命令分派（附录B §1.5 回复矩阵）：每个 case 的成功回复/失败文案逐条对齐官方。
// gate family：help/message/approve/task/stop 恒允许；reconnect→workspace；其余同名键。
/* eslint-disable max-lines -- §1.5 全命令 switch 矩阵单文件逐条对照官方回复文案，拆分反而增加终审比对成本。 */
import {
  listReplyModeOptions,
  resolveReplyGranularityByValue,
  normalizeBotReplyGranularity,
  type BotSelection,
  type OutboundMessage,
  type ParsedBotCommand,
} from "@zcode/shared/bots";
import { formatBotMessage } from "./hostMessages.js";
import {
  buildHelpText,
  buildStatusText,
  createOutbound,
  createSelectionReply,
  handlePendingElicitationText,
  handlePendingElicitationValue,
  submitPendingElicitation,
  type BotHandlerScope,
} from "./commandHandlers.js";
import { buildBotElicitationContent } from "./elicitation.js";
import { resolveSelectionOption } from "./selectionOptions.js";

export function resolveCommandFamily(parsed: ParsedBotCommand): string {
  switch (parsed.type) {
    case "help":
      return "help";
    case "status":
      return "status";
    case "new":
      return "new";
    case "workspace.list":
    case "workspace.set":
      return "workspace";
    case "model.list":
    case "model.provider.set":
    case "model.set":
      return "model";
    case "mode.list":
    case "mode.set":
      return "mode";
    case "thoughtLevel.list":
    case "thoughtLevel.set":
      return "thoughtLevel";
    case "task.list":
    case "task.set":
      return "task";
    case "reply.list":
    case "reply.set":
      return "reply";
    case "stop":
      return "stop";
    case "approve":
    case "deny":
    case "permission.respond":
      return "approve";
    default:
      return "message";
  }
}

function workspaceOptionLabel(label: string, remote: boolean, zh: boolean): string {
  return remote ? `${label} ${zh ? "[远端]" : "[Remote]"}` : label;
}

export async function handleParsedCommand(
  scope: BotHandlerScope,
  parsed: ParsedBotCommand,
): Promise<OutboundMessage[]> {
  const { deps, bot, actor, context, locale } = scope;
  const zh = locale !== "en-US";
  const statusReply = async (): Promise<OutboundMessage[]> => [
    createOutbound(actor, await buildStatusText(scope), undefined, { locale }),
  ];

  switch (parsed.type) {
    case "help":
      return [createOutbound(actor, buildHelpText(locale, bot), undefined, { locale })];
    case "status":
      return statusReply();
    case "new": {
      if (deps.taskBridge.isTaskRunning(context.activeTaskId)) {
        return [createOutbound(actor, formatBotMessage(locale, "taskRunning"), undefined, { locale })];
      }
      const next = await deps.writeDraftContext(context);
      return [
        createOutbound(
          actor,
          [
            formatBotMessage(locale, "newTaskDraft", { workspacePath: next.workspacePath }),
            await buildStatusText({ ...scope, context: next }),
          ].join("\n"),
          undefined,
          { locale },
        ),
      ];
    }
    case "workspace.list": {
      const refs = (await deps.listWorkspaceRefs()).filter(
        (ref) =>
          bot.allowedWorkspaces.length === 0 ||
          bot.allowedWorkspaces.includes("*") ||
          bot.allowedWorkspaces.includes(ref.id ?? "") ||
          bot.allowedWorkspaces.includes(ref.workspacePath),
      );
      if (refs.length === 0) {
        return [createOutbound(actor, formatBotMessage(locale, "workspaceMissing"), undefined, { locale })];
      }
      const current = refs.find((ref) => ref.id === context.workspaceId);
      const selection: BotSelection = {
        id: `workspace-${Date.now()}`,
        title: formatBotMessage(locale, "workspaceSelectTitle", {
          workspace: current
            ? workspaceOptionLabel(current.label, Boolean(current.remote), zh)
            : context.workspacePath,
        }),
        action: "workspace.set",
        options: refs.map((ref) => ({
          id: ref.id ?? ref.workspacePath,
          label: workspaceOptionLabel(ref.label, Boolean(ref.remote), zh),
        })),
        ...(current?.id ? { currentId: current.id } : {}),
        showCancel: true,
      };
      return createSelectionReply(scope, selection);
    }
    case "workspace.set": {
      const refs = await deps.listWorkspaceRefs();
      const hit =
        resolveSelectionOption(
          refs.map((ref) => ({ id: ref.id ?? ref.workspacePath, label: ref.label })),
          parsed.value,
        ) ?? null;
      const target = hit ? refs.find((ref) => (ref.id ?? ref.workspacePath) === hit.id) : undefined;
      if (!target) {
        return [createOutbound(actor, formatBotMessage(locale, "workspaceMissing"), undefined, { locale })];
      }
      const next = await deps.writeDraftContext({
        ...context,
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        workspaceId: target.id,
      });
      if (next.workspaceIdentity && !((await deps.isRemoteConnected?.(next)) ?? false)) {
        return [
          createOutbound(
            actor,
            formatBotMessage(locale, "remoteWorkspaceSelectedDisconnected", {
              workspacePath: next.workspacePath,
            }),
            undefined,
            { locale },
          ),
        ];
      }
      return [
        createOutbound(actor, await buildStatusText({ ...scope, context: next }), undefined, { locale }),
      ];
    }
    case "model.list": {
      const providers = await deps.listModelCatalog();
      if (providers.length === 0) {
        return [
          createOutbound(actor, formatBotMessage(locale, "modelProviderMissing"), undefined, { locale }),
        ];
      }
      const currentModel = context.draftOptions?.modelSelection;
      const selection: BotSelection = {
        id: `model-${Date.now()}`,
        title: formatBotMessage(locale, "modelProviderSelectTitle", {
          model: currentModel ? `${currentModel.providerId}/${currentModel.modelId}` : "-",
        }),
        action: "model.provider.set",
        options: providers.map((provider) => ({ id: provider.id, label: provider.name })),
        ...(currentModel ? { currentId: currentModel.providerId } : {}),
        showCancel: true,
      };
      return createSelectionReply(scope, selection);
    }
    case "model.provider.set": {
      const providers = await deps.listModelCatalog();
      const hit = providers.find((provider) => provider.id === parsed.value);
      if (!hit) {
        return [
          createOutbound(actor, formatBotMessage(locale, "modelProviderMissing"), undefined, { locale }),
        ];
      }
      if (hit.models.length === 0) {
        return [createOutbound(actor, formatBotMessage(locale, "modelMissing"), undefined, { locale })];
      }
      const currentModel = context.draftOptions?.modelSelection;
      const selection: BotSelection = {
        id: `model-${Date.now()}`,
        title: formatBotMessage(locale, "modelModelSelectTitle", {
          model: currentModel ? `${currentModel.providerId}/${currentModel.modelId}` : "-",
        }),
        action: "model.set",
        options: hit.models.map((model) => ({
          id: model.id,
          label: model.name,
          ...(model.thoughtLevels?.length ? { description: model.thoughtLevels.join(", ") } : {}),
        })),
        ...(currentModel?.modelId ? { currentId: currentModel.modelId } : {}),
        showCancel: true,
      };
      return createSelectionReply(scope, selection);
    }
    case "model.set": {
      const providers = await deps.listModelCatalog();
      let providerId = context.draftOptions?.modelSelection?.providerId;
      let modelId = parsed.value;
      for (const provider of providers) {
        const hit = resolveSelectionOption(
          provider.models.map((model) => ({ id: model.id, label: model.name })),
          parsed.value,
        );
        if (hit) {
          providerId = provider.id;
          modelId = hit.id;
          break;
        }
      }
      const resolution = await deps.resolveModelSelection(context, {
        providerId: providerId ?? "",
        modelId,
      });
      const effective = resolution.effectiveSelection;
      if (!effective || resolution.selectionIssue) {
        return [createOutbound(actor, formatBotMessage(locale, "modelMissing"), undefined, { locale })];
      }
      if (context.mode === "task" && context.activeTaskId) {
        await deps.taskBridge.setModelSafe({
          taskId: context.activeTaskId,
          modelSelection: effective,
        });
        await deps.taskBridge.broadcastTaskChange(context, context.activeTaskId, "updated", {
          provider: "glm",
          modelSelection: effective,
        });
        return statusReply();
      }
      const next = await deps.writeDraftContext(context, {
        provider: "glm",
        modelSelection: effective,
        ...(context.draftOptions?.mode ? { mode: context.draftOptions.mode } : {}),
      });
      return [
        createOutbound(actor, await buildStatusText({ ...scope, context: next }), undefined, { locale }),
      ];
    }
    case "mode.list":
    case "mode.set":
      return [createOutbound(actor, formatBotMessage(locale, "modeLocked"), undefined, { locale })];
    case "thoughtLevel.list": {
      const current = context.draftOptions?.modelSelection;
      const levels = await resolveThoughtLevelOptions(deps, context);
      if (levels.length === 0) {
        return [
          createOutbound(actor, formatBotMessage(locale, "thoughtLevelMissing"), undefined, { locale }),
        ];
      }
      const selection: BotSelection = {
        id: `thoughtLevel-${Date.now()}`,
        title: formatBotMessage(locale, "thoughtLevelSelectTitle", {
          level: current?.options?.reasoningLevel ?? "-",
        }),
        action: "thoughtLevel.set",
        options: levels.map((level) => ({ id: level, label: level })),
        ...(current?.options?.reasoningLevel ? { currentId: current.options.reasoningLevel } : {}),
        showCancel: true,
      };
      return createSelectionReply(scope, selection);
    }
    case "thoughtLevel.set": {
      const levels = await resolveThoughtLevelOptions(deps, context);
      const hit = resolveSelectionOption(
        levels.map((level) => ({ id: level, label: level })),
        parsed.value,
      );
      if (!hit) {
        return [
          createOutbound(actor, formatBotMessage(locale, "thoughtLevelMissing"), undefined, { locale }),
        ];
      }
      if (context.mode === "task" && context.activeTaskId) {
        await deps.taskBridge.setConfigOptionSafe({
          taskId: context.activeTaskId,
          configId: "thought_level",
          value: hit.id,
        });
        await deps.taskBridge.broadcastTaskChange(context, context.activeTaskId, "updated", {
          configOptions: [],
        });
        return statusReply();
      }
      const selection = context.draftOptions?.modelSelection;
      const next = await deps.writeDraftContext(context, {
        provider: "glm",
        ...(selection
          ? { modelSelection: { ...selection, options: { ...selection.options, reasoningLevel: hit.id } } }
          : {}),
        ...(context.draftOptions?.mode ? { mode: context.draftOptions.mode } : {}),
      });
      return [
        createOutbound(actor, await buildStatusText({ ...scope, context: next }), undefined, { locale }),
      ];
    }
    case "task.list": {
      if (deps.taskBridge.isTaskRunning(context.activeTaskId)) {
        return [createOutbound(actor, formatBotMessage(locale, "taskRunning"), undefined, { locale })];
      }
      const tasks = (await deps.taskBridge.listTasksSafe({ context }))
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 10);
      if (tasks.length === 0) {
        return [
          createOutbound(actor, formatBotMessage(locale, "noHistoryTasks"), undefined, { locale }),
        ];
      }
      const current = tasks.find((task) => task.taskId === context.activeTaskId);
      const selection: BotSelection = {
        id: `task-${Date.now()}`,
        title: formatBotMessage(locale, "taskSelectTitle", {
          task: current ? current.title : "-",
        }),
        action: "task.set",
        options: tasks.map((task) => ({ id: task.taskId, label: task.title })),
        ...(current ? { currentId: current.taskId } : {}),
        showCancel: true,
      };
      return createSelectionReply(scope, selection);
    }
    case "task.set": {
      if (deps.taskBridge.isTaskRunning(context.activeTaskId)) {
        return [createOutbound(actor, formatBotMessage(locale, "taskRunning"), undefined, { locale })];
      }
      const tasks = await deps.taskBridge.listTasksSafe({ context });
      const hit =
        resolveSelectionOption(
          tasks.map((task) => ({ id: task.taskId, label: task.title })),
          parsed.value,
        ) ?? null;
      const target = hit ? tasks.find((task) => task.taskId === hit.id) : undefined;
      if (!target) {
        return [createOutbound(actor, formatBotMessage(locale, "taskMissing"), undefined, { locale })];
      }
      const next = await deps.writeContext({
        ...context,
        mode: "task",
        activeTaskId: target.taskId,
        draftOptions: undefined,
      });
      return [
        createOutbound(actor, await buildStatusText({ ...scope, context: next }), undefined, { locale }),
      ];
    }
    case "reply.list": {
      const current = normalizeBotReplyGranularity(bot.provider, bot.replyMode);
      const options = listReplyModeOptions(bot.provider);
      const selection: BotSelection = {
        id: `reply-${Date.now()}`,
        title: formatBotMessage(locale, "replySelectTitle", { mode: current }),
        action: "reply.set",
        options: options.map((option) => ({
          id: option.mode,
          label: zh ? option.labelZh : option.labelEn,
          description: option.descriptionId,
        })),
        currentId: current,
        showCancel: true,
      };
      return createSelectionReply(scope, selection);
    }
    case "reply.set": {
      const resolved = resolveReplyGranularityByValue(bot.provider, parsed.value);
      if (!resolved) {
        return [createOutbound(actor, formatBotMessage(locale, "replyMissing"), undefined, { locale })];
      }
      await deps.saveBotConfig({ ...bot, replyMode: resolved });
      return statusReply();
    }
    case "stop": {
      if (!context.activeTaskId) {
        return [createOutbound(actor, formatBotMessage(locale, "noActiveTask"), undefined, { locale })];
      }
      try {
        await deps.taskBridge.stopGenerationSafe({ context, taskId: context.activeTaskId });
      } catch (error) {
        return [
          createOutbound(
            actor,
            formatBotMessage(locale, "taskFailed", {
              message: error instanceof Error ? error.message : String(error),
            }),
            undefined,
            { locale },
          ),
        ];
      }
      return [
        createOutbound(
          actor,
          [formatBotMessage(locale, "stopSubmitted"), await buildStatusText(scope)].join("\n"),
          undefined,
          { locale },
        ),
      ];
    }
    case "permission.respond": {
      const pendingOptions = context.pendingPermissionOptions ?? [];
      const index = Number.parseInt(parsed.value.trim(), 10);
      const option =
        Number.isInteger(index) && String(index) === parsed.value.trim() && index >= 1
          ? pendingOptions[index - 1]
          : undefined;
      if (!option) {
        return [
          createOutbound(actor, formatBotMessage(locale, "permissionExpired"), undefined, { locale }),
        ];
      }
      return respondPendingPermission(scope, option);
    }
    case "approve": {
      if (!context.activeTaskId) {
        return [createOutbound(actor, formatBotMessage(locale, "noActiveTask"), undefined, { locale })];
      }
      const option = (context.pendingPermissionOptions ?? []).find(
        (item) => item.requestId === parsed.requestId && item.optionId === parsed.optionId,
      );
      if (!option) {
        return [
          createOutbound(actor, formatBotMessage(locale, "permissionHandled"), undefined, { locale }),
        ];
      }
      return respondPendingPermission(scope, option);
    }
    case "deny": {
      if (!context.activeTaskId) {
        return [createOutbound(actor, formatBotMessage(locale, "noActiveTask"), undefined, { locale })];
      }
      const option = (context.pendingPermissionOptions ?? []).find(
        (item) => item.requestId === parsed.value && item.command === "deny",
      );
      const ok = await deps.taskBridge.respondPermissionSafe({
        context,
        taskId: context.activeTaskId,
        requestId: parsed.value,
        optionId: "deny",
        response: option?.response ?? { decision: "deny", reason: "Denied by bot command" },
      });
      if (!ok) {
        return [
          createOutbound(actor, formatBotMessage(locale, "permissionHandled"), undefined, { locale }),
        ];
      }
      await markPermissionResolved(scope, parsed.value);
      return [createOutbound(actor, formatBotMessage(locale, "permissionDenied"), undefined, { locale })];
    }
    case "elicitation.respond":
      return handlePendingElicitationValue(scope, parsed.value);
    case "elicitation.submit": {
      const pending = context.pendingElicitation;
      if (!pending || actor.provider !== "weixin") {
        return [
          createOutbound(actor, formatBotMessage(locale, "elicitationExpired"), undefined, { locale }),
        ];
      }
      return submitPendingElicitation(
        scope,
        pending,
        "accept",
        buildBotElicitationContent(pending, pending.answers),
      );
    }
    case "unknown":
      return [
        createOutbound(
          actor,
          formatBotMessage(locale, "unknownCommand", { command: parsed.name }),
          undefined,
          { locale },
        ),
      ];
    case "message": {
      const elicitationReplies = await handlePendingElicitationText(scope, parsed.text);
      return elicitationReplies ?? [];
    }
    default:
      return [];
  }
}

async function respondPendingPermission(
  scope: BotHandlerScope,
  option: NonNullable<import("@zcode/shared/bots").BotContext["pendingPermissionOptions"]>[number],
): Promise<OutboundMessage[]> {
  const { deps, actor, context, locale } = scope;
  if (!context.activeTaskId) {
    return [createOutbound(actor, formatBotMessage(locale, "noActiveTask"), undefined, { locale })];
  }
  if (option.handledAt) {
    return [createOutbound(actor, formatBotMessage(locale, "permissionHandled"), undefined, { locale })];
  }
  const ok = await deps.taskBridge.respondPermissionSafe({
    context,
    taskId: context.activeTaskId,
    requestId: option.requestId,
    optionId: option.optionId,
    response: option.response,
  });
  if (!ok) {
    return [createOutbound(actor, formatBotMessage(locale, "permissionHandled"), undefined, { locale })];
  }
  await markPermissionResolved(scope, option.requestId);
  return [
    createOutbound(
      actor,
      formatBotMessage(locale, option.command === "deny" ? "permissionDenied" : "permissionSubmitted"),
      undefined,
      { locale },
    ),
  ];
}

async function markPermissionResolved(scope: BotHandlerScope, requestId: string): Promise<void> {
  const { deps, context } = scope;
  await deps.repo.updateState((state) => ({
    ...state,
    bots: {
      ...state.bots,
      [scope.bot.id]: {
        ...context,
        pendingPermissionOptions: (context.pendingPermissionOptions ?? []).map((item) =>
          item.requestId === requestId ? { ...item, handledAt: deps.now() } : item,
        ),
        updatedAt: deps.now(),
      },
    },
  }));
  await deps.taskBridge.broadcastTaskChange(context, context.activeTaskId ?? requestId, "permission_resolved", {
    requestId,
  });
}

async function resolveThoughtLevelOptions(
  deps: BotHandlerScope["deps"],
  context: BotHandlerScope["context"],
): Promise<string[]> {
  const selection = context.draftOptions?.modelSelection;
  if (context.mode === "task" && context.activeTaskId) {
    const options = await deps.taskBridge.getTaskConfigOptionsSafe(context.activeTaskId);
    const thoughtLevel = options.find(
      (option) => option.type === "select" && (option.category === "thought_level" || option.id === "thought_level"),
    );
    return (thoughtLevel?.options ?? []).map((value) => value.value);
  }
  if (!selection) return [];
  const providers = await deps.listModelCatalog();
  const provider = providers.find((item) => item.id === selection.providerId);
  const model = provider?.models.find((item) => item.id === selection.modelId);
  return model?.thoughtLevels ?? [];
}
