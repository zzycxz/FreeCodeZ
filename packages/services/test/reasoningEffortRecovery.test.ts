import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isReasoningEffortInvalidMessage,
  parseSupportedReasoningEfforts,
  pickDegradedReasoningLevel,
  matchReasoningLevelPreset,
  getReasoningLevelPreset,
  REASONING_LEVEL_PRESETS,
} from "@zcode/shared/reasoning-effort-recovery";

// spec §6-10：共享归因判据单测——推理参数非法命中；鉴权/限流/网络不命中。

test("归因判据命中推理参数非法样本", () => {
  const hits = [
    "field reasoningeffort invalid",
    "Invalid 'reasoning_effort': 'xhigh' is not one of 'low','medium','high'",
    "Unknown parameter: 'reasoning_effort'",
    "reasoning_effort must be one of: low, medium, high",
    "reasoning_effort: Input should be 'low', 'medium' or 'high'",
    "This model does not support reasoning_effort",
    "field reasoning_effort not permitted",
    // 2026-09-23 MoMA 实证：拒绝词 unexpected 在参数名之前（空格形态），v1 三判据全部漏判。
    "Error code: 400 - {'error': {'message': 'Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low.', 'type': 'BadRequestError', 'param': None, 'code': 400}}",
  ];
  for (const message of hits) {
    assert.equal(isReasoningEffortInvalidMessage(message), true, `应命中: ${message}`);
  }
});

test("归因判据不命中鉴权/限流/网络与其它字段错误", () => {
  const misses = [
    "401 Unauthorized: invalid api key",
    "429 Too Many Requests: rate limit exceeded",
    "quota exceeded for this month",
    "network timeout while connecting to provider",
    "field tools.0.function.arguments invalid",
    "the prompt was rejected by safety filters",
  ];
  for (const message of misses) {
    assert.equal(isReasoningEffortInvalidMessage(message), false, `不应命中: ${message}`);
  }
});

test("支持词表解析：Supported types are / one of 两种锚点", () => {
  // MoMA 实证文案："(default)" 注解与 and/or 连接词剔除。
  assert.deepEqual(
    parseSupportedReasoningEfforts(
      "Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low.",
    ),
    ["xhigh", "medium", "low"],
  );
  // OpenAI/OpenRouter 引号列表形态。
  assert.deepEqual(
    parseSupportedReasoningEfforts(
      "Invalid 'reasoning_effort': 'xhigh' is not one of 'low','medium','high'",
    ),
    ["low", "medium", "high"],
  );
  assert.deepEqual(
    parseSupportedReasoningEfforts("reasoning_effort must be one of: low"),
    ["low"],
  );
  // 无锚点或解析不出有效值 → undefined（维持无词表的 v1 降级链）。
  assert.equal(parseSupportedReasoningEfforts("401 Unauthorized: invalid api key"), undefined);
  assert.equal(
    parseSupportedReasoningEfforts("Unknown parameter: 'reasoning_effort'"),
    undefined,
  );
});

test("降级目标：报错带词表时取交集最强档，交集为空不重试", () => {
  // 档位 [low,medium,high] 发 high 被拒，词表 {xhigh,medium,low} → 交集里最强且 ≠ 当前 → medium。
  assert.equal(
    pickDegradedReasoningLevel(["low", "medium", "high"], "high", ["xhigh", "medium", "low"]),
    "medium",
  );
  // MoMA 致命题：off-on 档位 ∩ {xhigh,medium,low} = ∅ → 不重试（enabled→high/disabled→none 双双非法）。
  assert.equal(
    pickDegradedReasoningLevel(["disabled", "enabled"], "enabled", ["xhigh", "medium", "low"]),
    undefined,
  );
  // 当前档不在词表、交集有多档时取声明序（强度升序）最强者。
  assert.equal(
    pickDegradedReasoningLevel(["low", "medium", "high", "xhigh"], "xhigh", ["low", "medium", "high"]),
    "high",
  );
  // 词表命中当前档之外无他档 → 不重试。
  assert.equal(pickDegradedReasoningLevel(["low"], "low", ["low", "medium"]), undefined);
});

test("降级目标无词表时维持 v1 链：优先 enabled，其次 disabled，再退最低档", () => {
  assert.equal(
    pickDegradedReasoningLevel(["disabled", "enabled"], "disabled"),
    "enabled",
  );
  assert.equal(
    pickDegradedReasoningLevel(["disabled", "enabled"], "enabled"),
    "disabled",
  );
  assert.equal(
    pickDegradedReasoningLevel(["low", "medium", "high", "xhigh", "max"], "max"),
    "low",
  );
  // 当前档已是唯一候选时不重试。
  assert.equal(pickDegradedReasoningLevel(["low"], "low"), undefined);
  assert.equal(pickDegradedReasoningLevel([], "low"), undefined);
});

test("预设值表合法：非空、不重复、无档位预设带空 map", () => {
  for (const preset of REASONING_LEVEL_PRESETS) {
    assert.ok(preset.values.length > 0, `${preset.id} values 不能为空`);
    assert.equal(new Set(preset.values).size, preset.values.length, `${preset.id} values 不能重复`);
  }
  assert.equal(getReasoningLevelPreset("no-reasoning")?.mapOverride, "{}");
  assert.equal(getReasoningLevelPreset("off-on")?.mapOverride, undefined);
});

test("预设匹配按值表精确（含顺序）", () => {
  assert.equal(matchReasoningLevelPreset(["disabled", "enabled"])?.id, "off-on");
  assert.equal(matchReasoningLevelPreset(["low", "medium", "high"])?.id, "low-medium-high");
  assert.equal(matchReasoningLevelPreset(["low", "high", "max"])?.id, "low-high-max");
  assert.equal(
    matchReasoningLevelPreset(["low", "medium", "high", "xhigh", "max"])?.id,
    "full-ladder",
  );
  assert.equal(matchReasoningLevelPreset(["disabled"])?.id, "no-reasoning");
  // 顺序颠倒不匹配（语义强度有序）。
  assert.equal(matchReasoningLevelPreset(["enabled", "disabled"]), undefined);
  assert.equal(matchReasoningLevelPreset([]), undefined);
  assert.equal(matchReasoningLevelPreset(["low", "high"]), undefined);
});
