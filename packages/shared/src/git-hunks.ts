// ============================================================
// 条目 7（升级实施手册）：diff hunk 级接受/拒绝——纯核心
// ============================================================
// 语义（对齐手册验收"10 hunk 拒 1 留 9"）：
//   "拒绝一个 hunk" = 把该 hunk 的改动反打回文件（worktree 内容回到该段旧值），
//   其余 hunk 的修改保留。实现 = jsdiff reversePatch(选中 hunk) + applyPatch(当前内容)。
// 纪律：
//   - 漂移预检：调用方传 expectedContentHash（观察 diff 时的内容指纹），与文件当前
//     内容指纹不符 → 结构化 stale 错误（闭集），绝不盲写（同 Edit/Write 的 0C-2③ 语义）。
//   - applyPatch 失败（hunk 上下文对不上）→ hunk_drift 错误，全不写（原子性）。
//   - 本模块纯函数（jsdiff + crypto），UI 与服务层共用，无 fs。

import { createHash } from "node:crypto";
import { applyPatch, parsePatch, reversePatch, type StructuredPatch } from "diff";

/** 从统一 diff 文本解析 hunk（文件维度的第一份 patch；多文件 patch 取首文件）。 */
export function parseSingleFilePatch(patch: string): StructuredPatch | undefined {
  try {
    const parsed = parsePatch(patch);
    return Array.isArray(parsed) ? parsed[0] : undefined;
  } catch {
    return undefined;
  }
}

/** hunk 展示元数据（UI 按钮/标签用，不含行体）。 */
export interface HunkSummary {
  index: number;
  oldStart: number;
  newStart: number;
  lines: number;
  added: number;
  removed: number;
  header: string;
}

export function summarizeHunks(patch: StructuredPatch | undefined): HunkSummary[] {
  if (!patch) return [];
  return patch.hunks.map((hunk, index) => ({
    index,
    oldStart: hunk.oldStart,
    newStart: hunk.newStart,
    lines: hunk.lines.length,
    added: hunk.lines.filter((line) => line.startsWith("+")).length,
    removed: hunk.lines.filter((line) => line.startsWith("-")).length,
    header: `${hunk.oldStart},${hunk.oldLines} ${hunk.newStart},${hunk.newLines}`,
  }));
}

/** 内容指纹（漂移预检）。 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export type RejectHunksResult =
  | { ok: true; content: string; rejectedCount: number; keptCount: number }
  | { ok: false; code: "stale_content" | "hunk_drift" | "bad_patch" | "bad_selection"; message: string };

/**
 * 拒绝选中 hunk：content = 文件当前内容；patch = 该文件观察时的统一 diff
 * （after 态包含全部 hunk 修改）。返回反打后的新内容（调用方负责落盘）。
 * 原子性：任一选中 hunk 应用失败 → 整体 hunk_drift，不返回部分结果。
 */
export function rejectHunksInContent(input: {
  content: string;
  patch: string | StructuredPatch;
  hunkIndexes: number[];
}): RejectHunksResult {
  const structured =
    typeof input.patch === "string" ? parseSingleFilePatch(input.patch) : input.patch;
  // parsePatch 对垃圾文本返回空 hunks 记录而非抛错——空 hunks 同样归一 bad_patch。
  if (!structured || structured.hunks.length === 0) {
    return { ok: false, code: "bad_patch", message: "patch text could not be parsed into hunks" };
  }
  const total = structured.hunks.length;
  const selected = [...new Set(input.hunkIndexes)].filter(
    (index) => Number.isInteger(index) && index >= 0 && index < total,
  );
  if (selected.length === 0) {
    return { ok: false, code: "bad_selection", message: "no valid hunk indexes selected" };
  }
  const selectedHunks = selected.map(
    (index) => structured.hunks[index] as StructuredPatch["hunks"][number],
  );
  const reverse = reversePatch({ ...structured, hunks: selectedHunks }) as StructuredPatch;
  const patched = applyPatch(input.content, reverse);
  if (patched === false) {
    return {
      ok: false,
      code: "hunk_drift",
      message: `hunk context no longer matches the file (rejected ${selected.length}/${total}); nothing was written`,
    };
  }
  return {
    ok: true,
    content: patched,
    rejectedCount: selected.length,
    keptCount: total - selected.length,
  };
}
