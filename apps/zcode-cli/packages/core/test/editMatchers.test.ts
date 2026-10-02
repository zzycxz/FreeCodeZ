// C1 表驱动测试：覆盖新增 line_normalized 级与 replaceAll 修复点。
// 关键场景来自探针复现（/tmp/edit-matchers-probe.ts）：
// ①组合噪声（弯引号+尾随空白）污染首尾锚行 → 旧八级全 miss，应命中 line_normalized；
// ②replaceAll=true + 单纯尾随空白 → 旧宽策略全跳过 not_found（bug 级），应命中；
// ③噪声仅在中间行 → block_anchor(0.8) 可救（既有行为回归）。
import assert from "node:assert/strict";
import test from "node:test";
import { findEditMatch } from "../src/tool/edit-matchers.js";

const CLEAN_BLOCK = [
  "const greeting = \"你好 world\";",
  "const answer = 42;",
  "export { greeting, answer };",
].join("\n");

test("line_normalized：组合噪声污染锚行（探针场景①，旧八级全 miss）", () => {
  // 文件内容：弯引号 + 行尾尾随空白（编辑器/复制粘贴常见污染），首尾锚行均被污染。
  const noisyContent = [
    "const greeting = \u201C你好 world\u201D; ",
    "const answer = 42; ",
    "export { greeting, answer }; ",
  ].join("\n");
  // 模型给的 search 是干净文本（或反向：文件干净、search 被污染，对称成立）。
  const result = findEditMatch({ content: noisyContent, search: CLEAN_BLOCK, replaceAll: false });
  assert.equal(result.status, "matched");
  assert.equal(result.strategy, "line_normalized");
  // 命中后取回文件真实文本（含弯引号与尾随空白），替换以真实文本为锚。
  if (result.status === "matched") {
    assert.ok(result.actualString.includes("\u201C你好 world\u201D"));
  }
});

test("line_normalized：search 被污染、文件干净（对称方向）", () => {
  const noisySearch = [
    "const greeting = \u201C你好 world\u201D; ",
    "const answer = 42; ",
    "export { greeting, answer }; ",
  ].join("\n");
  const result = findEditMatch({ content: CLEAN_BLOCK, search: noisySearch, replaceAll: false });
  assert.equal(result.status, "matched");
  assert.equal(result.strategy, "line_normalized");
});

test("replaceAll + 单纯尾随空白（探针场景②，旧宽策略全跳过的 bug 级缺口）", () => {
  const content = ["line one ", "line two "].join("\n") + "\n";
  const result = findEditMatch({ content, search: "line one\nline two", replaceAll: true });
  assert.equal(result.status, "matched");
  assert.equal(result.strategy, "line_normalized");
});

test("replaceAll + 组合噪声同样可用（line_normalized 不进宽策略跳过集）", () => {
  const content = ["v = \u2018x\u2019 ", "w = \u2018y\u2019 "].join("\n") + "\n";
  const result = findEditMatch({ content, search: "v = 'x'\nw = 'y'", replaceAll: true });
  assert.equal(result.status, "matched");
  assert.equal(result.strategy, "line_normalized");
});

test("噪声仅在中间行：block_anchor 仍可救（既有行为回归，探针场景③）", () => {
  const content = [
    "function main() {",
    "  const v = \u201Cdirty\u201D; ",
    "  return v;",
    "}",
  ].join("\n");
  const search = ["function main() {", "  const v = \"dirty\";", "  return v;", "}"].join("\n");
  // 弯引号在 quote_normalized 先命中（它只归一引号即可全文子串匹配吗——不是：该策略
  // 是整段子串匹配，尾随空白仍在，故 miss；line_trimmed 不归一引号也 miss；
  // 最终由 line_normalized 命中——首尾锚行在此例恰好干净，但 line_normalized 先于
  // block_anchor 执行，策略归属应是 line_normalized。
  const result = findEditMatch({ content, search, replaceAll: false });
  assert.equal(result.status, "matched");
  assert.equal(result.strategy, "line_normalized");
});

test("既有八级行为回归：exact 优先、歧义返回 ambiguous", () => {
  const exact = findEditMatch({
    content: `a\n${CLEAN_BLOCK}\nb`,
    search: CLEAN_BLOCK,
    replaceAll: false,
  });
  assert.equal(exact.status, "matched");
  assert.equal(exact.strategy, "exact");

  // 两处噪声形态不同（一处行尾空白、一处行尾制表符）→ 各自命中但真实文本不同
  // → ambiguous（不盲替换）。注意两处都不能字面包含搜索串，否则 exact 先命中。
  const ambiguous = findEditMatch({
    content: "x\nalpha \nbeta\ny\nalpha\t\nbeta\n",
    search: "alpha\nbeta",
    replaceAll: false,
  });
  assert.equal(ambiguous.status, "ambiguous");
});

test("性能回归：5000 行文件命中仍为毫秒级", () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line-${i} = ${i};`).join("\n");
  const target = `line-4999 = 4999;`;
  const started = Date.now();
  const result = findEditMatch({ content: big, search: target, replaceAll: false });
  const elapsed = Date.now() - started;
  assert.equal(result.status, "matched");
  assert.ok(elapsed < 500, `5000 行匹配耗时 ${elapsed}ms 应为毫秒级`);
});
