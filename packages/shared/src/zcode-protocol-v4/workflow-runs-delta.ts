// ============================================================
// workflowRuns 的增量同步（批次 2-3 / 上游 3.14.3 op-log 协议）
// ============================================================
// 3.14.0 每次 run 事件都整键重发 `state.updated { workflowRuns }`——状态键按事件整体
// 重发，一个 256 节点 run 的每条事件都是全量字节，O(N²)。3.14.3 把它改成 per-run 增量：
//   `{op:"workflowRun.updated", runId, revision, run?{字段}, cleared?[键], removedActors?/
//    removedNodes?[ref], actors?/nodes?[条目]}`——只发变化；
//   `{op:"workflowRun.removed", runId, revision}`——run 淘汰。
// 全量 `state.updated { workflowRuns }` 仍是兜底与冷恢复形态（diff 失败 / 旧端 / 水位推进）。
// 全部纯函数；语义逐条对照官方 3.14.3 反编译（docs/spec/upstream-fix-port-batches-0-1.md §8）。

import { z } from "zod";
import {
  WORKFLOW_RUNS_LIMITS,
  workflowRunActorSchema,
  workflowRunNodeSchema,
  workflowRunSchema,
  type WorkflowRunState,
  type WorkflowRunActor,
  type WorkflowRunNode,
  type WorkflowRunsState,
} from "./workflow-runs.js";

/** 实例身份键：actors 与 nodes 共用（siteId × ordinal）。 */
export function workflowRunEntryKey(entry: { siteId: string; ordinal: number }): string {
  return `${entry.siteId}\0${entry.ordinal}`;
}

const actorRefSchema = z.object({ siteId: z.string().min(1), ordinal: z.number().int().nonnegative() });

/**
 * per-run 增量。`run` 是**字段级**补丁（浅合并进既有 run）；`cleared` 是要从 run 上删除的
 * 键（值变 undefined 的字段没有别的表达）；`removedActors/removedNodes` 按 ref 删除；
 * `actors/nodes` 是**变更条目**（新条目追加，同键条目原地替换）。任何数组都受
 * {@link workflowRunUpdateWithinWireBounds} 界约束。
 */
export const workflowRunUpdateDeltaSchema = z.object({
  op: z.literal("workflowRun.updated"),
  runId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  run: workflowRunSchema.partial().optional(),
  cleared: z.array(z.string().min(1)).max(WORKFLOW_RUNS_LIMITS.maxNodes).optional(),
  removedActors: z.array(actorRefSchema).max(WORKFLOW_RUNS_LIMITS.maxActors).optional(),
  removedNodes: z.array(actorRefSchema).max(WORKFLOW_RUNS_LIMITS.maxNodes).optional(),
  actors: z.array(workflowRunActorSchema).max(WORKFLOW_RUNS_LIMITS.maxActors).optional(),
  nodes: z.array(workflowRunNodeSchema).max(WORKFLOW_RUNS_LIMITS.maxNodes).optional(),
});
export type WorkflowRunUpdateDelta = z.infer<typeof workflowRunUpdateDeltaSchema>;

export const workflowRunRemovedDeltaSchema = z.object({
  op: z.literal("workflowRun.removed"),
  runId: z.string().min(1),
  revision: z.number().int().nonnegative(),
});
export type WorkflowRunRemovedDelta = z.infer<typeof workflowRunRemovedDeltaSchema>;

/** 两条 per-run op 的判别（coalesce / legacy 编码都用）。 */
export function isWorkflowRunDelta(
  delta: { op: string },
): delta is WorkflowRunUpdateDelta | WorkflowRunRemovedDelta {
  return delta.op === "workflowRun.updated" || delta.op === "workflowRun.removed";
}

/** 深比较（JSON 值域；undefined 成员不算数）。 */
export function jsonValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonValueEqual(v, b[i]))
    );
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  let leftCount = 0;
  for (const key of Object.keys(left)) {
    const value = left[key];
    if (value !== undefined) {
      leftCount += 1;
      if (!jsonValueEqual(value, right[key])) return false;
    }
  }
  let rightCount = 0;
  for (const key of Object.keys(right)) if (right[key] !== undefined) rightCount += 1;
  return leftCount === rightCount;
}

// ——————————————————————————————— 生产端：diff ———————————————————————————————

/**
 * prev → next 的增量集。run 淘汰 → removed；run 变化 → per-run diff；任一 diff 失败
 * （null，键序/结构对不上）→ 整键全量兜底；零增量但 revision 变了 → 全量（水位要过河，
 * 而水位只在 state.updated 上表达）。
 */
export function diffWorkflowRunsState(
  previous: WorkflowRunsState | undefined,
  next: WorkflowRunsState,
): Array<WorkflowRunUpdateDelta | WorkflowRunRemovedDelta | { op: "state.updated"; patch: { workflowRuns: WorkflowRunsState } }> {
  const prevRuns = previous?.runs ?? [];
  const nextIds = new Set(next.runs.map((run) => run.runId));
  const deltas: Array<WorkflowRunUpdateDelta | WorkflowRunRemovedDelta> = [];
  for (const run of prevRuns) {
    if (!nextIds.has(run.runId)) deltas.push({ op: "workflowRun.removed", runId: run.runId, revision: next.revision });
  }
  const prevById = new Map(prevRuns.map((run) => [run.runId, run]));
  for (const run of next.runs) {
    const before = prevById.get(run.runId);
    if (before === run) continue;
    const delta = diffWorkflowRun(before, run, next.revision);
    if (delta === null) return [{ op: "state.updated", patch: { workflowRuns: next } }];
    if (delta !== undefined) deltas.push(delta);
  }
  if (deltas.length === 0 && (previous?.revision ?? -1) !== next.revision) {
    return [{ op: "state.updated", patch: { workflowRuns: next } }];
  }
  return deltas;
}

/**
 * 单 run diff：新 run → 全量 run 字段 + 整表 actors/nodes；既有 run → 变化字段 / 清除键 /
 * 删除条目 / 变更条目。返回 undefined = 无变化；null = 结构对不上（调用方全量兜底）。
 */
export function diffWorkflowRun(
  previous: WorkflowRunState | undefined,
  next: WorkflowRunState,
  revision: number,
): WorkflowRunUpdateDelta | null | undefined {
  if (previous === undefined) {
    const { actors: _actors, nodes: _nodes, ...rest } = next;
    void _actors;
    void _nodes;
    return {
      op: "workflowRun.updated",
      runId: next.runId,
      revision,
      run: rest as unknown as WorkflowRunUpdateDelta["run"],
      ...(next.actors.length > 0 ? { actors: [...next.actors] } : {}),
      ...(next.nodes.length > 0 ? { nodes: [...next.nodes] } : {}),
    };
  }
  const changed: Record<string, unknown> = {};
  const cleared: string[] = [];
  for (const [key, nextValue] of Object.entries(next)) {
    if (key === "actors" || key === "nodes") continue;
    const prevValue = (previous as Record<string, unknown>)[key];
    if (prevValue === nextValue) continue;
    if (nextValue === undefined) {
      cleared.push(key);
      continue;
    }
    if (prevValue !== undefined && !jsonValueEqual(prevValue, nextValue)) changed[key] = nextValue;
    else if (prevValue === undefined) changed[key] = nextValue;
  }
  const actors = diffWorkflowRunEntries(previous.actors, next.actors);
  const nodes = diffWorkflowRunEntries(previous.nodes, next.nodes);
  if (actors === null || nodes === null) return null;
  if (Object.keys(changed).length === 0 && cleared.length === 0 && actors === undefined && nodes === undefined) {
    return undefined;
  }
  return {
    op: "workflowRun.updated",
    runId: next.runId,
    revision,
    ...(Object.keys(changed).length > 0 ? { run: changed as WorkflowRunUpdateDelta["run"] } : {}),
    ...(cleared.length > 0 ? { cleared } : {}),
    ...(actors !== undefined && actors.removed.length > 0 ? { removedActors: actors.removed } : {}),
    ...(nodes !== undefined && nodes.removed.length > 0 ? { removedNodes: nodes.removed } : {}),
    ...(actors !== undefined && actors.changed.length > 0 ? { actors: actors.changed } : {}),
    ...(nodes !== undefined && nodes.changed.length > 0 ? { nodes: nodes.changed } : {}),
  };
}

/**
 * 条目表 diff：长度不增且键序保持前缀一致 → 只发变更条目（99% 的形态：追加与原地更新）；
 * 否则按键集 diff（删除 + 变更）；prev 键集不是 next 子集（有条目被换位/插入）→ null。
 */
export function diffWorkflowRunEntries<T extends { siteId: string; ordinal: number }>(
  previous: readonly T[],
  next: readonly T[],
): { removed: Array<{ siteId: string; ordinal: number }>; changed: T[] } | undefined | null {
  if (previous !== next) {
    if (previous.length <= next.length) {
      const changed: T[] = [];
      let aligned = true;
      for (let i = 0; i < next.length && aligned; i += 1) {
        const after = next[i]!;
        const before = previous[i];
        if (before === undefined) {
          changed.push(after);
          continue;
        }
        if (before !== after) {
          if (before.siteId !== after.siteId || before.ordinal !== after.ordinal) aligned = false;
          else if (!jsonValueEqual(before, after)) changed.push(after);
        }
      }
      if (aligned) return changed.length > 0 ? { removed: [], changed } : undefined;
    }
    return diffWorkflowRunEntriesByKey(previous, next);
  }
  return undefined;
}

function diffWorkflowRunEntriesByKey<T extends { siteId: string; ordinal: number }>(
  previous: readonly T[],
  next: readonly T[],
): { removed: Array<{ siteId: string; ordinal: number }>; changed: T[] } | undefined | null {
  const nextKeys = new Set(next.map(workflowRunEntryKey));
  const removed: Array<{ siteId: string; ordinal: number }> = [];
  const kept: T[] = [];
  for (const entry of previous) {
    if (nextKeys.has(workflowRunEntryKey(entry))) kept.push(entry);
    else removed.push({ siteId: entry.siteId, ordinal: entry.ordinal });
  }
  if (kept.length > next.length) return null;
  const changed: T[] = [];
  for (let i = 0; i < next.length; i += 1) {
    const after = next[i]!;
    const before = kept[i];
    if (before === undefined) {
      changed.push(after);
      continue;
    }
    if (before.siteId !== after.siteId || before.ordinal !== after.ordinal) return null;
    if (before !== after && !jsonValueEqual(before, after)) changed.push(after);
  }
  if (removed.length === 0 && changed.length === 0) return undefined;
  return { removed, changed };
}

// ——————————————————————————————— 消费端：apply ———————————————————————————————

/**
 * run 的必填头齐了吗（缺必填的 run 先攒着不进列表——增量可能先于完整头到达）。
 * 与官方 3.14.3 同判据：只看**非数组必填字段**；actors/nodes 随增量顶层走（新 run 的
 * 整表在 `actors`/`nodes` 键上，不在 `run` 里）。
 */
export function isCompleteWorkflowRunHeader(run: WorkflowRunUpdateDelta["run"]): boolean {
  const record = run as Record<string, unknown> | undefined;
  if (record === undefined) return false;
  return (
    record["runId"] !== undefined &&
    record["status"] !== undefined &&
    record["usage"] !== undefined &&
    record["lastEventSequence"] !== undefined
  );
}

/** 规范形：只留 defined 键（增量合并的读端不该看见 undefined 成员）。 */
export function canonicalWorkflowRun(run: Record<string, unknown>): WorkflowRunState {
  const canonical: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(run)) if (value !== undefined) canonical[key] = value;
  return canonical as unknown as WorkflowRunState;
}

function removeWorkflowRunEntries<T extends { siteId: string; ordinal: number }>(
  list: readonly T[],
  removed: ReadonlyArray<{ siteId: string; ordinal: number }> | undefined,
): T[] {
  if (removed === undefined || removed.length === 0) return list as T[];
  const keys = new Set(removed.map(workflowRunEntryKey));
  const next = list.filter((entry) => !keys.has(workflowRunEntryKey(entry)));
  return next.length === list.length ? (list as T[]) : next;
}

function upsertWorkflowRunEntries<T extends { siteId: string; ordinal: number }>(
  list: readonly T[],
  entries: readonly T[],
): T[] {
  const next = [...list];
  const indexByKey = new Map<string, number>();
  next.forEach((entry, index) => indexByKey.set(workflowRunEntryKey(entry), index));
  for (const entry of entries) {
    const key = workflowRunEntryKey(entry);
    const index = indexByKey.get(key);
    if (index === undefined) {
      indexByKey.set(key, next.length);
      next.push(entry);
      continue;
    }
    next[index] = entry;
  }
  return next;
}

/** 应用一条 workflowRun.updated 到容器（不存在/头不齐 → 除非头齐否则不入列表）。 */
export function applyWorkflowRunUpdated(
  state: WorkflowRunsState | undefined,
  delta: WorkflowRunUpdateDelta,
): WorkflowRunsState {
  const runs = state?.runs ?? [];
  const revision = Math.max(state?.revision ?? 0, delta.revision);
  const index = runs.findIndex((run) => run.runId === delta.runId);
  if (index < 0) {
    if (!isCompleteWorkflowRunHeader(delta.run ?? {})) {
      return state !== undefined && state.revision === revision ? state : { revision, runs };
    }
    const run = canonicalWorkflowRun({
      ...delta.run,
      actors: delta.actors === undefined ? [] : [...delta.actors],
      nodes: delta.nodes === undefined ? [] : [...delta.nodes],
    } as Record<string, unknown>);
    return { revision, runs: [...runs, run] };
  }
  const previous = runs[index]!;
  const merged: Record<string, unknown> = { ...previous, ...delta.run };
  for (const key of delta.cleared ?? []) delete merged[key];
  const actorsWithoutRemoved = removeWorkflowRunEntries(previous.actors, delta.removedActors);
  const nodesWithoutRemoved = removeWorkflowRunEntries(previous.nodes, delta.removedNodes);
  if (actorsWithoutRemoved !== previous.actors) merged.actors = actorsWithoutRemoved;
  if (nodesWithoutRemoved !== previous.nodes) merged.nodes = nodesWithoutRemoved;
  if (delta.actors !== undefined && delta.actors.length > 0) {
    merged.actors = upsertWorkflowRunEntries(actorsWithoutRemoved, delta.actors);
  }
  if (delta.nodes !== undefined && delta.nodes.length > 0) {
    merged.nodes = upsertWorkflowRunEntries(nodesWithoutRemoved, delta.nodes);
  }
  const nextRuns = [...runs];
  nextRuns[index] = canonicalWorkflowRun(merged);
  return { revision, runs: nextRuns };
}

export function applyWorkflowRunRemoved(
  state: WorkflowRunsState | undefined,
  delta: WorkflowRunRemovedDelta,
): WorkflowRunsState {
  const runs = state?.runs ?? [];
  const revision = Math.max(state?.revision ?? 0, delta.revision);
  const next = runs.filter((run) => run.runId !== delta.runId);
  if (next.length === runs.length) {
    return state !== undefined && state.revision === revision ? state : { revision, runs };
  }
  return { revision, runs: next };
}

// ——————————————————————————————— coalesce 支撑 ———————————————————————————————

/** 单条增量是否在 wire 界内（超界 → 不合并，直接独立发或全量兜底）。 */
export function workflowRunUpdateWithinWireBounds(
  delta: WorkflowRunUpdateDelta,
  limits: Pick<typeof WORKFLOW_RUNS_LIMITS, "maxActors" | "maxNodes"> = WORKFLOW_RUNS_LIMITS,
): boolean {
  return (
    (delta.actors?.length ?? 0) <= limits.maxActors &&
    (delta.removedActors?.length ?? 0) <= limits.maxActors &&
    (delta.nodes?.length ?? 0) <= limits.maxNodes &&
    (delta.removedNodes?.length ?? 0) <= limits.maxNodes
  );
}

function mergeRemovedRefs(
  a: ReadonlyArray<{ siteId: string; ordinal: number }> | undefined,
  b: ReadonlyArray<{ siteId: string; ordinal: number }> | undefined,
): Array<{ siteId: string; ordinal: number }> | undefined {
  if (a === undefined && b === undefined) return undefined;
  const merged: Array<{ siteId: string; ordinal: number }> = [];
  const seen = new Set<string>();
  for (const ref of [...(a ?? []), ...(b ?? [])]) {
    const key = workflowRunEntryKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(ref);
  }
  return merged.length > 0 ? merged : undefined;
}

function mergeEntryLists<T extends { siteId: string; ordinal: number }>(
  a: readonly T[] | undefined,
  b: readonly T[] | undefined,
  removed: ReadonlyArray<{ siteId: string; ordinal: number }> | undefined,
): T[] | undefined {
  if (a === undefined && b === undefined) return undefined;
  const removedKeys = new Set((removed ?? []).map(workflowRunEntryKey));
  const base =
    removedKeys.size === 0 ? (a ?? []) : (a ?? []).filter((entry) => !removedKeys.has(workflowRunEntryKey(entry)));
  const merged = upsertWorkflowRunEntries(base, b ?? []);
  return merged.length > 0 ? merged : undefined;
}

/** 同 run 两条增量合并为一条（coalesce 用；revision 取大）。 */
export function mergeWorkflowRunUpdates(
  a: WorkflowRunUpdateDelta,
  b: WorkflowRunUpdateDelta,
): WorkflowRunUpdateDelta {
  const run: Record<string, unknown> = { ...a.run, ...b.run };
  const bCleared = new Set(b.cleared ?? []);
  for (const key of bCleared) delete run[key];
  const cleared: string[] = [];
  for (const key of a.cleared ?? []) if (run[key] === undefined && !cleared.includes(key)) cleared.push(key);
  for (const key of b.cleared ?? []) if (!cleared.includes(key)) cleared.push(key);
  const removedActors = mergeRemovedRefs(a.removedActors, b.removedActors);
  const removedNodes = mergeRemovedRefs(a.removedNodes, b.removedNodes);
  const actors = mergeEntryLists(a.actors, b.actors, b.removedActors);
  const nodes = mergeEntryLists(a.nodes, b.nodes, b.removedNodes);
  return {
    op: "workflowRun.updated",
    runId: b.runId,
    revision: Math.max(a.revision, b.revision),
    ...(Object.keys(run).length > 0 ? { run: run as WorkflowRunUpdateDelta["run"] } : {}),
    ...(cleared.length > 0 ? { cleared } : {}),
    ...(removedActors === undefined ? {} : { removedActors }),
    ...(removedNodes === undefined ? {} : { removedNodes }),
    ...(actors === undefined ? {} : { actors }),
    ...(nodes === undefined ? {} : { nodes }),
  };
}

// ——————————————————————————————— 旧端与预算 ———————————————————————————————

/** 保活优先裁剪：超界时优先留未完结条目（在序），凑满 limit 再补前面的。 */
function clampKeepingLive<T>(list: readonly T[], limit: number, isLive: (entry: T) => boolean): T[] {
  if (list.length <= limit) return list as T[];
  const keep = new Set<number>();
  for (let i = 0; i < list.length && keep.size < limit; i += 1) if (isLive(list[i]!)) keep.add(i);
  for (let i = 0; i < list.length && keep.size < limit; i += 1) keep.add(i);
  return list.filter((_, index) => keep.has(index));
}

/** 旧端全量兜底前的裁剪（发整键时也把列表裁到界内、标 truncated）。 */
export function clampWorkflowRunsForLegacy(state: WorkflowRunsState): WorkflowRunsState {
  let changed = false;
  const runs = state.runs.map((run) => {
    const actors = clampKeepingLive(run.actors, WORKFLOW_RUNS_LIMITS.maxActors, (actor) => actor.status !== "completed");
    const nodes = clampKeepingLive(run.nodes, WORKFLOW_RUNS_LIMITS.maxNodes, (node) => node.phase !== "settled");
    if (actors === run.actors && nodes === run.nodes) return run;
    changed = true;
    return canonicalWorkflowRun({ ...run, actors, nodes, truncated: true });
  });
  return changed ? { revision: state.revision, runs } : state;
}

/**
 * 旧端编码：deltas 里若有 per-run 增量，用一条全量（legacy 裁剪后）替换**最后一条**增量
 * 所在位置——旧端不认识新 op，整条 stream 任何位置出现它都会解析失败，所以只在「增量之后
 * 再无其他 op」的收尾位置安全替换；中间夹杂其他 op 时保持原样（调用方保证不走到这里）。
 */
export function encodeConversationDeltasForLegacy(
  deltas: ReadonlyArray<{ op: string }>,
  state: WorkflowRunsState | undefined,
): ReadonlyArray<{ op: string }> {
  let last = -1;
  for (let i = deltas.length - 1; i >= 0; i -= 1) {
    if (isWorkflowRunDelta(deltas[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0) return deltas;
  const replacement =
    state === undefined ? null : { op: "state.updated", patch: { workflowRuns: clampWorkflowRunsForLegacy(state) } };
  const encoded: Array<{ op: string }> = [];
  for (let i = 0; i < deltas.length; i += 1) {
    const delta = deltas[i]!;
    if (!isWorkflowRunDelta(delta)) {
      encoded.push(delta);
      continue;
    }
    if (i === last && replacement !== null) encoded.push(replacement);
  }
  return encoded;
}

/** 增量链的体积上限估算（序列化字节 + 常数），调用方据此决定全量兜底。 */
export function workflowRunDeltaGrowthUpperBound(deltas: ReadonlyArray<{ op: string }>): number {
  for (const delta of deltas) {
    if (delta.op !== "workflowRun.updated" && delta.op !== "workflowRun.removed") return 0;
  }
  return new TextEncoder().encode(JSON.stringify(deltas)).byteLength + 64;
}
