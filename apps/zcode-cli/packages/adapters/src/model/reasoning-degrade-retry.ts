import type { Logger } from "@zcode/contracts";
import {
  isReasoningEffortInvalidMessage,
  pickDegradedReasoningLevel,
} from "@zcode/shared/reasoning-effort-recovery";
import type { ModelExecutionRequest } from "./model.js";

/**
 * L1 当次自动降级重试（docs/spec/model-reasoning-level-presets.md §2.3）：
 * 模型接口拒绝推理参数时，本次请求以安全档重试一次。降级是请求内部瞬时行为，
 * 不落任何持久状态、不改用户已保存的档位配置（持久修复走 L2 一键按钮）。
 */
function buildDegradedRequest(
  request: ModelExecutionRequest,
  error: unknown,
  reasoningValues: readonly string[],
  logger?: Logger,
): ModelExecutionRequest | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!isReasoningEffortInvalidMessage(message)) return undefined;
  const degradedLevel = pickDegradedReasoningLevel(
    reasoningValues,
    request.options.reasoningLevel,
  );
  if (!degradedLevel) return undefined;
  // 可恢复异常（spec §日志）：warn 一次，记录原档位与降级档位，不含用户数据与凭据。
  logger?.warn(
    `reasoning effort rejected by provider; retrying once with degraded level (from "${request.options.reasoningLevel}" to "${degradedLevel}")`,
  );
  return {
    ...request,
    options: { ...request.options, reasoningLevel: degradedLevel },
  };
}

export async function runGenerateWithReasoningDegrade<T>(
  request: ModelExecutionRequest,
  run: (request: ModelExecutionRequest) => Promise<T>,
  reasoningValues: readonly string[],
  logger?: Logger,
): Promise<T> {
  try {
    return await run(request);
  } catch (error) {
    // 整段生成失败时调用方尚未消费任何内容，整体重试一次是安全的。
    const degraded = buildDegradedRequest(request, error, reasoningValues, logger);
    if (!degraded) throw error;
    return run(degraded);
  }
}

export async function* runStreamWithReasoningDegrade<T>(
  request: ModelExecutionRequest,
  run: (request: ModelExecutionRequest) => AsyncIterable<T>,
  reasoningValues: readonly string[],
  logger?: Logger,
): AsyncGenerator<T> {
  let current = request;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let started = false;
    try {
      for await (const event of run(current)) {
        started = true;
        yield event;
      }
      return;
    } catch (error) {
      // 已流出事件的失败不能整体重试，否则已消费的正文会被重复一遍；
      // 只有"一个事件都没到"的失败（请求被整体拒绝）才允许降级重试。
      if (attempt === 0 && !started) {
        const degraded = buildDegradedRequest(current, error, reasoningValues, logger);
        if (degraded) {
          current = degraded;
          continue;
        }
      }
      throw error;
    }
  }
}
