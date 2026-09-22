/**
 * 推理档位预设与失败自愈的共享规则（docs/spec/model-reasoning-level-presets.md）。
 *
 * L1 请求侧自动降级重试（adapters）、L2 错误横幅一键修复（UI）与错误归因共用本模块，
 * 避免多处 regex 各自漂移；本文件保持纯函数，不做 IO。
 */

/**
 * 模型接口拒绝推理参数的判据（值域非法 / 未知字段类）。
 * 保守命中：鉴权、限流、网络类错误绝不能触发降级重试，负例由单测钉住。
 */
const REASONING_EFFORT_INVALID_PATTERNS: readonly RegExp[] = [
  // Anthropic 风格信封:"field reasoningeffort invalid"
  /field\s+reasoningeffort\s+invalid/iu,
  // 拒绝词在推理参数名之前:Invalid 'reasoning_effort' / Unknown parameter: reasoning_effort /
  // This model does not support reasoning_effort
  /(?:invalid|unknown|unsupported|illegal|unrecognized|does\s+not\s+support|cannot\s+(?:use|accept)|(?:extra\s+inputs?|field)\s+(?:is\s+)?not\s+(?:permitted|allowed|supported))[^.\n]{0,40}reasoning[_\s-]?efforts?/iu,
  // 推理参数名在前:reasoning_effort must be one of ... / reasoning_effort: Input should be ...
  /reasoning[_\s-]?efforts?[^.\n]{0,40}(?:invalid|unknown|unsupported|illegal|unrecognized|not\s+(?:supported|allowed|permitted)|must\s+be|one\s+of|literal_error|out\s+of\s+range|input\s+should\s+be)/iu,
];

export function isReasoningEffortInvalidMessage(message: string): boolean {
  return REASONING_EFFORT_INVALID_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * L1 降级目标档位（spec §2.3）：优先 `enabled`（通用 map 归一为 high，保住思考），
 * 当前档已是 enabled 或不存在时退 `disabled`（归一为 none），再退档位表最低档。
 * 返回 undefined 表示无可降目标，不应重试。
 */
export function pickDegradedReasoningLevel(
  values: readonly string[],
  current: string | undefined,
): string | undefined {
  const candidates = ["enabled", "disabled", values[0] ?? ""] as const;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!values.includes(candidate)) continue;
    if (candidate === current) continue;
    return candidate;
  }
  return undefined;
}

export type ReasoningLevelPresetId =
  | "off-on"
  | "low-medium-high"
  | "low-high-max"
  | "full-ladder"
  | "no-reasoning";

export interface ReasoningLevelPreset {
  readonly id: ReasoningLevelPresetId;
  /** 按语义强度从低到高；值名即请求体透传值，只用各家族通行的标准 effort 名。 */
  readonly values: readonly string[];
  /** 需要同时覆盖 map 时写入（「无档位」用空对象 map 阻断一切推理参数透传）。 */
  readonly mapOverride?: string;
}

/**
 * 档位阶梯预设（spec §2.1）：值域对齐内置规则表中真实模型家族的形态。
 * 默认预设是 off-on，其余仅在用户显式选择时生效。
 */
export const REASONING_LEVEL_PRESETS: readonly ReasoningLevelPreset[] = [
  { id: "off-on", values: ["disabled", "enabled"] },
  { id: "low-medium-high", values: ["low", "medium", "high"] },
  { id: "low-high-max", values: ["low", "high", "max"] },
  { id: "full-ladder", values: ["low", "medium", "high", "xhigh", "max"] },
  // 无档位：complete schema 要求 values 非空，用单档 disabled + 空 map 阻断推理参数透传。
  { id: "no-reasoning", values: ["disabled"], mapOverride: "{}" },
];

export function getReasoningLevelPreset(
  id: ReasoningLevelPresetId,
): ReasoningLevelPreset | undefined {
  return REASONING_LEVEL_PRESETS.find((preset) => preset.id === id);
}

/** 当前值表与预设完全一致（含顺序）时返回该预设；顺序也是语义（低到高），不做归一比较。 */
export function matchReasoningLevelPreset(
  values: readonly string[],
): ReasoningLevelPreset | undefined {
  return REASONING_LEVEL_PRESETS.find(
    (preset) =>
      preset.values.length === values.length &&
      preset.values.every((value, index) => value === values[index]),
  );
}
