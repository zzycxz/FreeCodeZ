// 从 workflow-runs-reducer.ts 拆出（max-lines 门）：有界 upsert 的两个取键形态。
// 语义见各函数头注释（原地保留）；批次 2-3 的 admitNew 水位门在 Instance 形态里。

import type { WorkflowRunPendingQuestion } from "./workflow-runs.js";

/**
 * 按 (siteId, ordinal) upsert 进有界列表。
 *
 * 触界时的语义是**拒绝新条目、仍接受已有条目的更新**：把一个正在跑的实例的相位冻结在
 * "queued" 上，比少列一个实例更容易误导读者（图上那一格会永远显示没开始）。
 */
export function upsertBoundedByInstance<T extends { siteId: string; ordinal: number }>(
  list: readonly T[],
  entry: T,
  limit: number,
  options?: { admitNew?: boolean },
): { list: T[]; truncated: boolean } {
  const index = list.findIndex(
    (item) => item.siteId === entry.siteId && item.ordinal === entry.ordinal,
  );
  if (index >= 0) {
    const next = [...list];
    next[index] = entry;
    return { list: next, truncated: false };
  }
  // 批次 2-3（admitNew）：重放/迟到事件（不推进水位）不新建条目——已在列的可照常更新。
  // 这让「同一条事件应用两次」逐字节一致，unlisted 计数因此才敢落在状态里。
  if (list.length >= limit || options?.admitNew === false) {
    return { list: [...list], truncated: list.length >= limit };
  }
  return { list: [...list, entry], truncated: false };
}

/**
 * 按 `qid` upsert 进有界的停驻问题表。
 *
 * 与 `upsertBoundedByInstance` 是同一条触界语义（拒新、仍更新已有），只是键不同：升级没有
 * 站点实例身份，qid 才是它的键。没有把两者合并成一个泛型函数，是因为键的**取法**正是这里
 * 唯一要说的事——合并之后调用点要传一个取键函数，读者反而看不出"这张表按什么去重"。
 */
export function upsertBoundedByQid(
  list: readonly WorkflowRunPendingQuestion[],
  entry: WorkflowRunPendingQuestion,
  limit: number,
): { list: WorkflowRunPendingQuestion[]; truncated: boolean } {
  const index = list.findIndex((item) => item.qid === entry.qid);
  if (index >= 0) {
    const next = [...list];
    next[index] = entry;
    return { list: next, truncated: false };
  }
  if (list.length >= limit) return { list: [...list], truncated: true };
  return { list: [...list, entry], truncated: false };
}
