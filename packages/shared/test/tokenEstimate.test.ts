// B1 统一估算口径锁定测试：CJK 按 3 个估算字符计、其余按 1 计、总和 ÷4 向上取整。
// 验收两条：①英文估算低于旧 ÷3 口径 ≥25%（修正提前压缩）；②中文估算不低于旧
// context/utils 口径（CJK×2÷3=0.667/字 → 新 0.75/字，防溢出回归）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  CJK_CHAR_ESTIMATE_WEIGHT,
  ESTIMATED_TOKEN_CHAR_DIVISOR,
  estimateTokensFromText,
} from "../src/token-estimate.js";

test("常量口径：divisor=4、CJK 权重=3", () => {
  assert.equal(ESTIMATED_TOKEN_CHAR_DIVISOR, 4);
  assert.equal(CJK_CHAR_ESTIMATE_WEIGHT, 3);
});

test("绝对值锁定：纯英文/纯中文/混合", () => {
  // 8 个 ASCII → ceil(8/4)=2
  assert.equal(estimateTokensFromText("abcdefgh"), 2);
  // 5 个中文 → ceil(5*3/4)=ceil(3.75)=4
  assert.equal(estimateTokensFromText("中中中中中"), 4);
  // 混合 4 ASCII + 1 中文 → ceil((4+3)/4)=2
  assert.equal(estimateTokensFromText("abcd中"), 2);
  assert.equal(estimateTokensFromText(""), 0);
});

test("验收①：英文估算较旧 ÷3 口径下调 25%", () => {
  const english = "a".repeat(1200);
  const oldCaliber = Math.ceil(english.length / 3);
  const newCaliber = estimateTokensFromText(english);
  assert.equal(newCaliber, 300);
  assert.ok(newCaliber <= oldCaliber * 0.75, `新口径 ${newCaliber} 应 ≤ 旧口径 ${oldCaliber} 的 75%`);
});

test("验收②：中文估算不低于旧 context/utils 口径（CJK×2÷3）", () => {
  const chinese = "中".repeat(1200);
  const oldCaliber = Math.ceil((chinese.length * 2) / 3); // = 800
  const newCaliber = estimateTokensFromText(chinese); // = ceil(3600/4) = 900
  assert.ok(newCaliber >= oldCaliber, `新口径 ${newCaliber} 不得低于旧口径 ${oldCaliber}（防溢出回归）`);
});
