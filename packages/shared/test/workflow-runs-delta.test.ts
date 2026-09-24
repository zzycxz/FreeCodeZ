// 批次 2-3 delta 协议单测（规格 §8 / 验收 A9 的协议面）：
// diff→apply 往返等价（黄金性质）、removed/merge/coalesce、水位准入门控与 unlisted 计数。
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWorkflowRunRemoved,
  applyWorkflowRunUpdated,
  clampWorkflowRunsForLegacy,
  diffWorkflowRunsState,
  encodeConversationDeltasForLegacy,
  mergeWorkflowRunUpdates,
  type WorkflowRunUpdateDelta,
} from "../src/zcode-protocol-v4/workflow-runs-delta.js";
import type { WorkflowRunsState } from "../src/zcode-protocol-v4/workflow-runs.js";
import {
  reduceWorkflowRunsState as reduceFromReducer,
} from "../src/zcode-protocol-v4/workflow-runs-reducer.js";
import { coalesceConversationDeltas } from "../src/zcode-protocol-v4/coalesce.js";
import { applyConversationDeltas } from "../src/zcode-protocol-v4/apply.js";
import type { ConversationSnapshot } from "../src/zcode-protocol-v4/snapshot.js";

function runOf(runId: string, patch: Record<string, unknown> = {}): WorkflowRunsState {
  return {
    revision: 1,
    runs: [
      {
        runId,
        status: "running",
        usage: { spentTokens: 0, nodesUsed: 0 },
        actors: [],
        nodes: [],
        lastEventSequence: 0,
        ...(patch as object),
      } as WorkflowRunsState["runs"][number],
    ],
  };
}

test("diff→apply 往返等价：字段变化 / 条目变化 / 新 run / 删除 run", () => {
  const before = runOf("r1", {
    error: undefined,
    actors: [{ siteId: "a", ordinal: 0, status: "running" } as never],
    nodes: [{ siteId: "n", ordinal: 0, phase: "queued" } as never],
  });
  const after: WorkflowRunsState = {
    revision: 2,
    runs: [
      {
        ...(before.runs[0] as object),
        status: "running",
        usage: { spentTokens: 42, nodesUsed: 1 },
        actors: [
          { siteId: "a", ordinal: 0, status: "completed" } as never,
          { siteId: "a", ordinal: 1, status: "running" } as never,
        ],
        nodes: [
          { siteId: "n", ordinal: 0, phase: "settled", outcome: "ok" } as never,
          { siteId: "n", ordinal: 1, phase: "queued" } as never,
        ],
        lastEventSequence: 3,
      } as never,
      {
        runId: "r2",
        status: "pending",
        usage: { spentTokens: 0, nodesUsed: 0 },
        actors: [],
        nodes: [],
        lastEventSequence: 0,
      } as never,
    ],
  };
  const deltas = diffWorkflowRunsState(before, after);
  assert.equal(deltas.length, 2); // r1.updated + r2.updated（新 run 全量头）
  let applied = before;
  for (const delta of deltas) {
    const snapshot = { workflowRuns: applied } as unknown as ConversationSnapshot;
    applied = applyConversationDeltas(snapshot, [delta as never]).workflowRuns!;
  }
  assert.deepEqual(JSON.parse(JSON.stringify(applied)), JSON.parse(JSON.stringify(after)));

  // 删除：after 不再含 r1 → removed；应用后 runs 只剩 r2。
  const removed = diffWorkflowRunsState(after, { revision: 3, runs: after.runs.slice(1) });
  assert.equal(removed.length, 1);
  assert.equal(removed[0]!.op, "workflowRun.removed");
  let afterRemoved = after;
  for (const delta of removed) {
    afterRemoved = applyWorkflowRunRemoved(afterRemoved, delta as never);
  }
  assert.deepEqual(afterRemoved.runs.map((r) => r.runId), ["r2"]);
});

test("零增量但 revision 变化 → 全量兜底（水位必须过河）", () => {
  const before = runOf("r1");
  const after: WorkflowRunsState = { revision: before.revision + 1, runs: before.runs };
  const deltas = diffWorkflowRunsState(before, after);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0]!.op, "state.updated");
  // 真正的零变化（同 revision）→ 空。
  assert.deepEqual(diffWorkflowRunsState(before, before), []);
});

test("mergeWorkflowRunUpdates：字段/清除/删除/条目并一条；revision 取大", () => {
  const a: WorkflowRunUpdateDelta = {
    op: "workflowRun.updated",
    runId: "r1",
    revision: 5,
    run: { status: "running" } as never,
    actors: [{ siteId: "a", ordinal: 0, status: "running" } as never],
  };
  const b: WorkflowRunUpdateDelta = {
    op: "workflowRun.updated",
    runId: "r1",
    revision: 7,
    cleared: ["error"],
    removedNodes: [{ siteId: "n", ordinal: 2 }],
    nodes: [{ siteId: "n", ordinal: 3, phase: "queued" } as never],
  };
  const merged = mergeWorkflowRunUpdates(a, b);
  assert.equal(merged.revision, 7);
  assert.deepEqual(merged.cleared, ["error"]);
  assert.equal(merged.run?.status, "running");
  assert.deepEqual(merged.removedNodes, [{ siteId: "n", ordinal: 2 }]);
  assert.equal((merged.nodes as never[]).length, 1);
  assert.deepEqual(merged.actors, a.actors);
});

test("coalesce：同 run 相邻增量并一条；removed 吞并其前 updated；state.updated(全量) 是屏障", () => {
  const u1: WorkflowRunUpdateDelta = {
    op: "workflowRun.updated",
    runId: "r1",
    revision: 1,
    run: { status: "running" } as never,
  };
  const u2: WorkflowRunUpdateDelta = {
    op: "workflowRun.updated",
    runId: "r1",
    revision: 2,
    run: { usage: { spentTokens: 1, nodesUsed: 0 } } as never,
  };
  const coalesced = coalesceConversationDeltas([u1 as never, u2 as never]);
  assert.equal(coalesced.length, 1);
  assert.equal((coalesced[0] as WorkflowRunUpdateDelta).revision, 2);

  const removed = coalesceConversationDeltas([
    u1 as never,
    u2 as never,
    { op: "workflowRun.removed", runId: "r1", revision: 3 },
  ]);
  assert.equal(removed.length, 1);
  assert.equal(removed[0]!.op, "workflowRun.removed");

  const barrier = coalesceConversationDeltas([
    u1 as never,
    { op: "state.updated", patch: { workflowRuns: runOf("r1") } },
    u2 as never,
  ]);
  // 全量在中间：u1 与 u2 不得跨它合并。
  assert.equal(barrier.filter((d) => d.op === "workflowRun.updated").length, 2);
});

test("reducer：水位准入门控 + unlisted 计数 + 幂等重放", () => {
  const events = Array.from({ length: 260 }, (_, i) => ({
    eventType: "node-queued",
    sequence: i + 1,
    runId: "r1",
    payload: {
      instance: { siteId: `s${i}`, ordinal: 0 },
      kind: "ask",
      actor: { siteId: `a${i % 8}`, ordinal: 0 },
    },
  }));
  let state: WorkflowRunsState | undefined;
  for (const event of events) state = reduceFromReducer(state, event as never) ?? state;
  const run = state!.runs[0]!;
  // 260 个出生事件、maxNodes 256 → 4 个被拒入 unlisted。
  assert.equal(run.nodes.length, 256);
  assert.equal(run.usage.nodesUnlisted, 4);
  assert.equal(run.truncated, true);
  // 幂等：重放最后一条（sequence 不推进水位）不计数、不产 delta。
  const replay = reduceFromReducer(state, events[259]! as never);
  assert.equal(replay, null);
});

test("legacy 编码：增量流替换为一条全量（clamped + truncated 标记）", () => {
  const big = runOf("r1", {
    actors: Array.from({ length: 300 }, (_, i) => ({
      siteId: `a${i}`,
      ordinal: 0,
      status: "completed",
    })) as never,
  });
  const encoded = encodeConversationDeltasForLegacy(
    [
      { op: "row.appended" } as never,
      { op: "workflowRun.updated", runId: "r1", revision: 2 } as never,
    ],
    big,
  );
  assert.equal(encoded.length, 2);
  assert.equal(encoded[1]!.op, "state.updated");
  const clamped = clampWorkflowRunsForLegacy(big);
  assert.equal(clamped.runs[0]!.actors.length, 256);
  assert.equal(clamped.runs[0]!.truncated, true);
  // 不动的那一侧：未超界的 state 原样返回（引用相等）。
  const small = runOf("r1");
  assert.equal(JSON.stringify(clampWorkflowRunsForLegacy(small)), JSON.stringify(small));
});

test("applyWorkflowRunUpdated：头不齐的新 run 不入列表；cleared 删键；条目 upsert 原地替换", () => {
  const base = runOf("r1");
  // 头不齐：只有 status，没有 usage/actors/nodes → 不入列表，但 revision 抬。
  const partial = applyWorkflowRunUpdated(base, {
    op: "workflowRun.updated",
    runId: "r9",
    revision: 9,
    run: { status: "running" } as never,
  });
  assert.equal(partial.runs.length, 1);
  assert.equal(partial.revision, 9);
  // 完整头 → 入列。
  const full = applyWorkflowRunUpdated(partial, {
    op: "workflowRun.updated",
    runId: "r9",
    revision: 10,
    run: {
      runId: "r9",
      status: "running",
      usage: { spentTokens: 0, nodesUsed: 0 },
      actors: [],
      nodes: [],
      lastEventSequence: 0,
    } as never,
  });
  assert.equal(full.runs.length, 2);
  // cleared + upsert：
  const patched = applyWorkflowRunUpdated(base, {
    op: "workflowRun.updated",
    runId: "r1",
    revision: 3,
    run: { resultPreview: "x" } as never,
  });
  const cleared = applyWorkflowRunUpdated(patched, {
    op: "workflowRun.updated",
    runId: "r1",
    revision: 4,
    cleared: ["resultPreview"],
  });
  assert.equal(cleared.runs[0]!.resultPreview, undefined);
});
