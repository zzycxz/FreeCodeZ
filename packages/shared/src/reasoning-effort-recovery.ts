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
  // This model does not support reasoning_effort /
  // Unexpected reasoning effort high（MoMA 2026-09-23 实证，缺 unexpected 会整族漏判）
  /(?:invalid|unknown|unsupported|illegal|unrecognized|unexpected|does\s+not\s+support|cannot\s+(?:use|accept)|(?:extra\s+inputs?|field)\s+(?:is\s+)?not\s+(?:permitted|allowed|supported))[^.\n]{0,40}reasoning[_\s-]?efforts?/iu,
  // 推理参数名在前:reasoning_effort must be one of ... / reasoning_effort: Input should be ...
  /reasoning[_\s-]?efforts?[^.\n]{0,40}(?:invalid|unknown|unsupported|illegal|unrecognized|not\s+(?:supported|allowed|permitted)|must\s+be|one\s+of|literal_error|out\s+of\s+range|input\s+should\s+be)/iu,
];

export function isReasoningEffortInvalidMessage(message: string): boolean {
  return REASONING_EFFORT_INVALID_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * 支持词表锚点（§2.3 修订一）：命中任一锚点后，从锚点后至句号/换行前的片段提取候选值。
 * 仅在 isReasoningEffortInvalidMessage 命中后调用，避免误吃无关文案。
 */
const SUPPORTED_EFFORT_LIST_PATTERNS: readonly RegExp[] = [
  /supported\s+(?:types|values|efforts?)\s+are\s+([^.\n]+)/iu,
  /one\s+of[:\s]+([^.\n]+)/iu,
];

/** 词表片段里不该当档位的连接词/说明词（"(default)" 注解也靠它排除）。 */
const EFFORT_LIST_STOP_WORDS = new Set([
  "a", "an", "and", "are", "be", "default", "input", "is", "must", "of", "or",
  "should", "supported", "the", "types", "values", "effort", "efforts",
]);

/**
 * 从推理参数报错中解析服务端声明的合法档位词表（§2.3 修订一）。
 * MoMA 实证文案:"Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low."
 * → ["xhigh","medium","low"]。解析不出（无锚点/无有效值）返回 undefined。
 */
export function parseSupportedReasoningEfforts(message: string): string[] | undefined {
  for (const pattern of SUPPORTED_EFFORT_LIST_PATTERNS) {
    const match = pattern.exec(message);
    if (!match) continue;
    const tokens = match[1]!
      .replace(/['"]/gu, "")
      .split(/[^a-zA-Z0-9_-]+/u)
      .map((token) => token.toLowerCase())
      .filter(
        (token) => token.length > 0 && token.length <= 16 && !EFFORT_LIST_STOP_WORDS.has(token),
      );
    if (tokens.length > 0) return [...new Set(tokens)];
  }
  return undefined;
}

/**
 * L1 降级目标档位（spec §2.3）：
 * - 报错携带支持词表时（修订一）：目标必须同时 ∈ 档位表与词表，取交集里强度最高且 ≠ 当前档者；
 *   交集为空说明任何降级目标都注定再被拒（MoMA 实证：off-on 档位的 enabled→high 与
 *   disabled→none 双双非法），不重试、直接上抛交 L2，避免白烧一次请求。
 * - 无词表时维持 v1 语义：优先 `enabled`（通用 map 归一为 high，保住思考），
 *   当前档已是 enabled 或不存在时退 `disabled`（归一为 none），再退档位表最低档。
 * 返回 undefined 表示无可降目标，不应重试。
 */
export function pickDegradedReasoningLevel(
  values: readonly string[],
  current: string | undefined,
  supported?: readonly string[],
): string | undefined {
  if (supported && supported.length > 0) {
    const allowed = values.filter(
      (value) => supported.includes(value) && value !== current,
    );
    return allowed.length > 0 ? allowed[allowed.length - 1] : undefined;
  }
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
