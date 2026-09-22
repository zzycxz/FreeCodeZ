import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isReasoningEffortInvalidMessage,
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

test("降级目标优先 enabled，其次 disabled，再退最低档", () => {
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
