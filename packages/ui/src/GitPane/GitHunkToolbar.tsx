// 条目 7（升级实施手册）：hunk 级操作工具条 + 逐 hunk 拒绝按钮（Shadow DOM 外层渲染）。
// 设计：@pierre/diffs 渲染在 Shadow DOM 内无法注入按钮——本组件按 hunk 摘要（shared
// summarizeHunks）在 diff 上方渲染操作条：split/unified 切换（不丢滚动位置——条在
// diff 外、滚动容器不变）+ 逐 hunk「拒绝」按钮 + 全部拒绝（discard 语义确认弹窗由
// 调用方处理，本组件只发事件）。
import { useMemo, useState } from "react";
import { Columns2Icon, RowsIcon, UndoIcon } from "lucide-react";
import type { GitDiffResult } from "@zcode/shared";
import { parseSingleFilePatch, summarizeHunks } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";

export interface GitHunkToolbarProps {
  diff: GitDiffResult;
  /** hunk 拒绝（调用方带确认/错误呈现；返回非 ok 时按钮恢复可用）。 */
  onRejectHunks: (hunkIndexes: number[]) => Promise<void>;
  /** 全部拒绝 = 文件级 discard（destructive——调用方必须先弹确认）。 */
  onRejectAll: (() => void) | undefined;
  busy?: boolean;
}

export function GitHunkToolbar({
  diff,
  onRejectHunks,
  onRejectAll,
  busy,
  split,
  onSplitChange,
}: GitHunkToolbarProps & { split?: boolean; onSplitChange?: (split: boolean) => void }) {
  const [localSplit, setLocalSplit] = useState(false);
  const effectiveSplit = split ?? localSplit;
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const hunks = useMemo(() => summarizeHunks(parseSingleFilePatch(diff.patch ?? "")), [diff.patch]);

  const rejectOne = async (index: number) => {
    setPendingIndex(index);
    try {
      await onRejectHunks([index]);
    } finally {
      setPendingIndex(null);
    }
  };

  if (hunks.length === 0) return null;

  return (
    <div className="flex w-full flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-1.5">
      <button
        type="button"
        data-diff-style-toggle={split ? "split" : "unified"}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-ui-sm text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
        onClick={() => {
          const next = !effectiveSplit;
          setLocalSplit(next);
          onSplitChange?.(next);
        }}
        title={split ? "Switch to unified" : "Switch to split"}
      >
        {effectiveSplit ? <Columns2Icon className="size-3.5" /> : <RowsIcon className="size-3.5" />}
        {effectiveSplit ? "Split" : "Unified"}
      </button>
      <div className="h-4 w-px bg-border" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" data-hunk-list>
        {hunks.map((hunk) => (
          <button
            key={hunk.index}
            type="button"
            data-reject-hunk={hunk.index}
            disabled={busy || pendingIndex !== null}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle transition-colors",
              "hover:border-destructive/60 hover:text-destructive",
              (busy || pendingIndex !== null) && "opacity-50",
            )}
            title={`Reject hunk @@ -${hunk.header} @@ (+${hunk.added}/-${hunk.removed})`}
            onClick={() => void rejectOne(hunk.index)}
          >
            <UndoIcon className="size-3" />@@ {hunk.newStart}
          </button>
        ))}
      </div>
      {onRejectAll ? (
        <button
          type="button"
          data-reject-all-hunks
          disabled={busy}
          className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-ui-sm text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
          onClick={onRejectAll}
        >
          <UndoIcon className="size-3.5" />
          Discard all ({hunks.length})
        </button>
      ) : null}
    </div>
  );
}

/** 当前 split 态透传给 DiffViewer 的 options 片段。 */
export function diffStyleForSplit(split: boolean): { diffStyle: "split" | "unified" } {
  return split ? { diffStyle: "split" } : { diffStyle: "unified" };
}
