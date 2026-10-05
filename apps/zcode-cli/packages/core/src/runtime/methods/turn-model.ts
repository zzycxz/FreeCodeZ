import {
  SESSION_ENTRY_MODEL_SELECTION,
  type Model,
  type ModelSelection,
  type TraceContext,
  type TurnInputIntentMetadata,
} from "@zcode/contracts";
import { getCurrentModelInvocationContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { createRuntimeModel, withModelInvocationContext } from "./runtime-model.js";
import { applyRuntimeExecutionState } from "../execution-state.js";

export function createTurnModel(
  runtime: AgentRuntimeInternal,
  options: {
    selection?: ModelSelection;
    requestDependencies?: import("@zcode/contracts").ModelRequestDependencies;
  } = {},
): Model {
  const selection = options.selection ?? runtime.getSessionModelSelection();
  const model = createRuntimeModel(runtime, {
    selection,
    requestDependencies: options.requestDependencies,
  });
  return withModelInvocationContext(model, (request) => ({
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
      abortSignal: request.abortSignal,
      model,
      traceContext: getCurrentModelInvocationContext()?.traceContext ?? runtime.rootTraceContext,
    }),
  }));
}

/**
 * 在 Submission 真正开始执行或 Guide 被下一次 model step 消费时应用其执行配置。
 * 选择只决定新创建的 Model；已经被其他 Loop 持有的 Model 不会被修改。
 */
export async function applySubmissionExecutionState(
  runtime: AgentRuntimeInternal,
  intent: TurnInputIntentMetadata | undefined,
  traceContext: TraceContext,
  modelExecution?: import("../types.js").ModelExecutionContext,
  preparedModel?: Model,
): Promise<Model | undefined> {
  const selection = intent?.modelSelection;
  const previousSelection = runtime.getSessionModelSelection();
  let model = preparedModel;

  if (selection) {
    model ??= createTurnModel(runtime, {
      selection,
      requestDependencies: modelExecution?.requestDependencies,
    });
    if (modelExecution?.selectionScope !== "execution") {
      const appliedSelection = cloneModelSelection(selection);
      runtime.setSessionModelSelection(appliedSelection);
      await persistRuntimeModelSelection(runtime, appliedSelection);
      if (!sameModelSelection(previousSelection, appliedSelection)) {
        await runtime.emitModelSelected({
          model,
          modelSelection: appliedSelection,
          effectiveReasoningLevel: model.options.reasoningLevel,
          previousModelSelection: previousSelection,
          supportedThoughtLevels: model.optionSpecs.reasoningLevel.values,
          traceContext,
        });
      }
    }
  }

  if (intent?.mode !== undefined || intent?.planEnabled !== undefined) {
    await applyRuntimeExecutionState(runtime, intent, { source: "command", traceContext });
  }

  return model;
}

export function sameModelSelection(
  left: ModelSelection | undefined,
  right: ModelSelection,
): boolean {
  return (
    left?.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}

export async function persistRuntimeModelSelection(
  runtime: AgentRuntimeInternal,
  selection: ModelSelection,
  options?: { rowExists?: boolean },
): Promise<void> {
  if (!runtime.sessionStore?.saveSessionEntry) return;
  // 0B-1（升级实施手册）：session_entries.sessionID 外键指向 sessions 行；懒落库完成前
  // 写入必触发 FOREIGN KEY constraint failed（session_create 后切模型/首轮流内定选型均撞
  // 此窗口）。会话行未落地时跳过——选型已先写入 runtime 内存（setSessionModelSelection），
  // 懒落库的初始选型回写（events.ts ensureSessionPersisted）会在行创建后落同一稳定 entry，
  // 不丢数据。rowExists 供回写路径自证（createSession 返回后行已在）。
  if (!options?.rowExists && !runtime.sessionPersisted) return;
  const timestamp = Date.now();
  try {
    await runtime.sessionStore.saveSessionEntry({
      id: `${runtime.sessionId}:runtime-model-selection`,
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      data: selection,
    });
  } catch (error) {
    runtime.logger?.warn("Session model selection persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.model_selection.persist_failed",
      modelId: selection.modelId,
      module: "core.runtime",
      providerId: selection.providerId,
      status: "failed",
      thoughtLevel: selection.options?.reasoningLevel,
    });
  }
}
