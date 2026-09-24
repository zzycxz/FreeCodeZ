// ============================================================
// unlisted 节点的计数与按阶段桶（批次 2-3 / 上游 3.14.3 ehr/lhr）
// ============================================================
// 从 workflow-runs-reducer.ts 拆出（max-lines 门）。上游 3.14.3 的两个函数在此同语义：
// 计数（ehr）：出生事件触界被拒 → nodesUnlisted+1；任何 node-settled 被拒 → unlistedSettled+1；
// 按阶段桶（lhr）：被拒节点结算时 settled 记入其阶段桶；其 actor 再无任何在列节点时，
// actors/actorsSettled 记入 actor 的阶段桶并从 actors[] 除籍（展示位让给活着的）。

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunNode,
  type WorkflowRunState,
  type WorkflowRunUnlistedPhase,
  type WorkflowRunUsage,
} from "./workflow-runs.js";

/**
 * 被拒事件的 unlisted 计数（上游 ehr）。只在「触界被拒 ∧ 推进水位」时调用——水位门是
 * 幂等锚，同一事件重放不重计。bornEvent = node-queued / cached node-settled（出生形态）。
 */
export function countUnlistedUsage(
  usage: WorkflowRunUsage,
  input: {
    rejected: boolean;
    advancesWaterMark: boolean;
    eventType: string;
    cached: boolean;
  },
): WorkflowRunUsage {
  if (!input.rejected || !input.advancesWaterMark) return usage;
  const settled = input.eventType === "node-settled";
  const born = input.eventType === "node-queued" || (settled && input.cached);
  if (!born && !settled) return usage;
  const unlisted = (usage.nodesUnlisted ?? 0) + (born ? 1 : 0);
  const unlistedSettled = (usage.nodesUnlistedSettled ?? 0) + (settled ? 1 : 0);
  return {
    ...usage,
    ...(unlisted > 0 ? { nodesUnlisted: unlisted } : {}),
    ...(unlistedSettled > 0 ? { nodesUnlistedSettled: unlistedSettled } : {}),
  };
}

/**
 * 被拒节点的结算按阶段入桶（上游 lhr 主干）。终态（completed）actor 不除籍——终态 run 的
 * actors 表是最终阵容，把终态成员移进桶里会让 roster 少人。
 */
export function rollupUnlistedSettle(
  run: WorkflowRunState,
  node: WorkflowRunNode,
  actorRef: { siteId: string; ordinal: number } | undefined,
): WorkflowRunState {
  const buckets = bumpUnlistedPhase(run.unlistedByPhase ?? [], node.phaseName, { settled: 1 });
  if (actorRef === undefined) return { ...run, unlistedByPhase: buckets };
  const actorIndex = run.actors.findIndex(
    (actor) => actor.siteId === actorRef.siteId && actor.ordinal === actorRef.ordinal,
  );
  if (actorIndex < 0) return { ...run, unlistedByPhase: buckets };
  const actor = run.actors[actorIndex]!;
  const actorStillListed = run.nodes.some(
    (listed) => listed.actorSiteId === actor.siteId && listed.actorOrdinal === actor.ordinal,
  );
  if (actorStillListed || actor.status === "completed") return { ...run, unlistedByPhase: buckets };
  const withActor = bumpUnlistedPhase(buckets, actor.phaseName, { actors: 1, actorsSettled: 1 });
  return {
    ...run,
    actors: run.actors.filter((_, index) => index !== actorIndex),
    unlistedByPhase: withActor,
  };
}

function bumpUnlistedPhase(
  buckets: readonly WorkflowRunUnlistedPhase[],
  phaseName: string | undefined,
  bump: { settled?: number; actors?: number; actorsSettled?: number; actorsFailed?: number },
): WorkflowRunUnlistedPhase[] {
  if (phaseName === undefined) return [...buckets];
  const index = buckets.findIndex((bucket) => bucket.phaseName === phaseName);
  const base: WorkflowRunUnlistedPhase = index >= 0 ? buckets[index]! : { phaseName, actors: 0, settled: 0 };
  const next: WorkflowRunUnlistedPhase = {
    ...base,
    actors: base.actors + (bump.actors ?? 0),
    settled: base.settled + (bump.settled ?? 0),
    ...(bump.actorsSettled === undefined
      ? base.actorsSettled === undefined
        ? {}
        : { actorsSettled: base.actorsSettled }
      : { actorsSettled: (base.actorsSettled ?? 0) + bump.actorsSettled }),
    ...(bump.actorsFailed === undefined
      ? base.actorsFailed === undefined
        ? {}
        : { actorsFailed: base.actorsFailed }
      : { actorsFailed: (base.actorsFailed ?? 0) + bump.actorsFailed }),
  };
  if (index >= 0) {
    const copy = [...buckets];
    copy[index] = next;
    return copy;
  }
  if (buckets.length >= WORKFLOW_RUNS_LIMITS.maxPhases + 1) return [...buckets];
  return [...buckets, next];
}
