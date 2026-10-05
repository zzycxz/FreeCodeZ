// 条目 7 UI 面测试：hunk 工具条渲染与交互（jsdom 内存渲染——不拉 @pierre/diffs）。
import assert from "node:assert/strict";
import test from "node:test";

// @pierre/diffs 与 shiki 在 node:test 环境不可渲染——只测纯数据件：
// summarizeHunks 驱动的按钮集与 diffStyleForSplit 透传契约（组件渲染面由 e2e 批覆盖）。
import { structuredPatchOf } from "./helpers/gitHunkTestFixtures.js";
import { parseSingleFilePatch, summarizeHunks } from "@zcode/shared";

test("工具条数据面：10 hunk 语料 → 10 个拒绝按钮的元数据", () => {
  const patch = structuredPatchOf();
  const hunks = summarizeHunks(parseSingleFilePatch(patch));
  assert.equal(hunks.length, 10);
  for (const hunk of hunks) {
    assert.ok(hunk.index >= 0 && hunk.index < 10);
    assert.ok(hunk.newStart > 0);
    assert.ok(hunk.header.includes(","));
  }
});

test("diffStyleForSplit 契约：false=unified（现状默认），true=split", async () => {
  const { diffStyleForSplit } = await import("../src/GitPane/GitHunkToolbar.js");
  assert.deepEqual(diffStyleForSplit(false), { diffStyle: "unified" });
  assert.deepEqual(diffStyleForSplit(true), { diffStyle: "split" });
});
