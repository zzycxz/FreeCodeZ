// 条目 7（升级实施手册）：diff hunk 级接受/拒绝——纯核心测试。
// 语义钉死：拒 N 留 M（反打选中 hunk）、漂移预检 stale_content、上下文对不上
// hunk_drift 全不写（原子）、坏 patch/空选择结构化错误。
import assert from "node:assert/strict";
import test from "node:test";
import { structuredPatch } from "diff";
import {
  parseSingleFilePatch,
  summarizeHunks,
  hashContent,
  rejectHunksInContent,
} from "../src/git-hunks.js";

function makePatch(before: string, after: string): string {
  const patch = structuredPatch("f.txt", "f.txt", before, after, "", "", { context: 1 });
  return [
    `--- ${patch.oldFileName}`,
    `+++ ${patch.newFileName}`,
    ...patch.hunks.map((hunk) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`),
  ].join("\n");
}

// 10 hunk 语料：相隔足够远保证独立成 hunk（context 1）。
const LINES = Array.from({ length: 60 }, (_, index) => `line-${index}`);
const MODIFIED_LINES = LINES.map((line, index) => (index % 6 === 0 ? `${line}-MOD` : line));
const BEFORE = LINES.join("\n");
const AFTER = MODIFIED_LINES.join("\n");
const PATCH = makePatch(BEFORE, AFTER);

test("解析与摘要：10 个 hunk，增删行计数正确", () => {
  const parsed = parseSingleFilePatch(PATCH);
  assert.ok(parsed);
  const hunks = summarizeHunks(parsed);
  assert.equal(hunks.length, 10);
  for (const hunk of hunks) {
    assert.ok(hunk.added >= 1);
    assert.ok(hunk.removed >= 1);
    assert.ok(hunk.header.includes(","));
  }
});

test("拒 1 留 9：反打 hunk[3]，其余 9 个修改保留", () => {
  const result = rejectHunksInContent({ content: AFTER, patch: PATCH, hunkIndexes: [3] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rejectedCount, 1);
  assert.equal(result.keptCount, 9);
  const lines = result.content.split("\n");
  assert.equal(lines[18], "line-18", "hunk[3] 恢复旧值（第 19 行 = index 18）");
  assert.equal(lines[0], "line-0-MOD", "其余修改保留");
  assert.equal(lines[6], "line-6-MOD");
});

test("拒 10 留 0：全量反打 = 回到 before", () => {
  const result = rejectHunksInContent({ content: AFTER, patch: PATCH, hunkIndexes: Array.from({ length: 10 }, (_, i) => i) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.content, BEFORE);
});

test("漂移：hunk 上下文对不上 → hunk_drift 且全不写（原子）", () => {
  const drifted = AFTER.split("\n").map((line, i) => (i === 30 ? "totally-different" : line)).join("\n");
  const result = rejectHunksInContent({ content: drifted, patch: PATCH, hunkIndexes: [5] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "hunk_drift");
  assert.ok(result.message.includes("nothing was written"));
});

test("坏选择/坏 patch 结构化错误", () => {
  assert.equal(rejectHunksInContent({ content: AFTER, patch: PATCH, hunkIndexes: [] }).ok, false);
  const empty = rejectHunksInContent({ content: AFTER, patch: "not a patch", hunkIndexes: [0] });
  assert.equal(empty.ok, false);
  if (empty.ok) return;
  assert.equal(empty.code, "bad_patch");
  const badIndex = rejectHunksInContent({ content: AFTER, patch: PATCH, hunkIndexes: [99] });
  assert.equal(badIndex.ok, false);
  if (badIndex.ok) return;
  assert.equal(badIndex.code, "bad_selection");
});

test("内容指纹：稳定且区分内容", () => {
  assert.equal(hashContent(BEFORE), hashContent(BEFORE));
  assert.notEqual(hashContent(BEFORE), hashContent(AFTER));
  assert.equal(hashContent("x").length, 64);
});
