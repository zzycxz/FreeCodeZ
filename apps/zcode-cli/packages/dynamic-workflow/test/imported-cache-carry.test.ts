// 批次 2-2 carry 单测：携带资格四条件、崩溃恢复的 carriedSeq 重建、ReplaySettleOrder
// 放行序、构建器 resolveInFlightAsk 四道门。规格 R4 / 验收 A8 的引擎层。
import assert from "node:assert/strict";
import test from "node:test";
import { ImportedActorState } from "../src/engine/imported-cache.js";
import { ReplaySettleOrder, recoverReplaySettleOrder } from "../src/engine/scheduler-replay.js";
import { InMemoryJournalStore } from "../src/engine/journal-memory.js";
import { buildImportedCache } from "../../bootstrap/src/app/dynamic-workflow-import.js";
import type { ImportedActorCandidate } from "../src/engine/imported-cache-types.js";

function candidate(overrides: Partial<ImportedActorCandidate> = {}): ImportedActorCandidate {
  return {
    persona: { name: "reviewer" },
    entries: [
      { inputHash: "h0", result: "r0", messageBoundary: 2, stats: { worldToolCalls: 0 } },
    ],
    transcriptSourceSessionId: "sess-a",
    ...overrides,
  };
}

test("携带判定：开门期不命中恰落在在飞槽（同槽/全消费/同哈希）→ carriedAt + seed 取在飞边界", () => {
  const state = new ImportedActorState(
    candidate({ inFlight: { inputHash: "h1", messageBoundary: 7 } }),
  );
  assert.equal(state.take(0, "h0")?.result, "r0");
  assert.equal(state.take(1, "h1"), undefined);
  assert.equal(state.carriedAt(1), true);
  const seed = state.seed();
  assert.deepEqual(seed, { sourceSessionId: "sess-a", messageCount: 7 });
});

test("携带判定：哈希不符 / 中段分歧 / 关门后不命中 / 无在飞条目 → 永不携带", () => {
  const wrongHash = new ImportedActorState(candidate({ inFlight: { inputHash: "h1", messageBoundary: 7 } }));
  wrongHash.take(1, "other");
  assert.equal(wrongHash.carriedAt(1), false);

  const midDiverge = new ImportedActorState(
    candidate({
      entries: [
        { inputHash: "h0", result: "r0", messageBoundary: 2 },
        { inputHash: "h1", result: "r1", messageBoundary: 4 },
      ],
      inFlight: { inputHash: "h2", messageBoundary: 9 },
    }),
  );
  midDiverge.take(1, "h1-wrong");
  assert.equal(midDiverge.carriedAt(1), false);
  assert.equal(midDiverge.carriedAt(2), false);

  const postClose = new ImportedActorState(candidate({ inFlight: { inputHash: "h1", messageBoundary: 7 } }));
  postClose.take(0, "h0");
  // 模拟关门后：takeIfPure 不命中（entries 耗尽）→ carryEligible=false。
  postClose.takeIfPure(1, "h1");
  assert.equal(postClose.carriedAt(1), false);

  const noInFlight = new ImportedActorState(candidate());
  noInFlight.take(0, "h0");
  noInFlight.take(1, "h1");
  assert.equal(noInFlight.carriedAt(1), false);
  assert.equal(noInFlight.seed()?.messageCount, 2);
});

test("崩溃恢复：reconcileRecorded 第 4 参重建 carriedSeq（关门前准入的 live 行才携带）", () => {
  const state = new ImportedActorState(candidate({ inFlight: { inputHash: "h1", messageBoundary: 7 } }));
  // resume 按序重推：seq0 先按非 live 记录行消费，seq1 是崩溃前的 live 行。
  state.reconcileRecorded(0, "h0", false, true);
  state.reconcileRecorded(1, "h1", true, true);
  assert.equal(state.carriedAt(1), true);
  assert.equal(state.seed()?.messageCount, 7);

  const postCloseLive = new ImportedActorState(candidate({ inFlight: { inputHash: "h1", messageBoundary: 7 } }));
  postCloseLive.reconcileRecorded(0, "h0", false, true);
  postCloseLive.reconcileRecorded(1, "h1", true, false);
  assert.equal(postCloseLive.carriedAt(1), false);
});

test("ReplaySettleOrder：按记录序放行；未知立即；open 清空剩余", () => {
  const settled: string[] = [];
  const order = new ReplaySettleOrder(["a", "b", "c"]);
  order.hold("b", () => settled.push("b"));
  assert.deepEqual(settled, []);
  order.hold("x", () => settled.push("x"));
  assert.deepEqual(settled, ["x"]);
  order.hold("a", () => settled.push("a"));
  assert.deepEqual(settled, ["x", "a", "b"]);
  order.hold("c", () => settled.push("c"));
  assert.deepEqual(settled, ["x", "a", "b", "c"]);

  const parked = new ReplaySettleOrder(["p", "q"]);
  parked.hold("q", () => settled.push("q"));
  parked.open();
  parked.hold("p", () => settled.push("p"));
  assert.deepEqual(settled, ["x", "a", "b", "c", "q", "p"]);
});

test("recoverReplaySettleOrder：结算事件序重建，report 不入表", async () => {
  const journal = new InMemoryJournalStore();
  journal.createRun({ runId: "run-r", caps: { maxConcurrency: 1 }, spentTokens: 0, status: "running" });
  const emit = (event: Parameters<InMemoryJournalStore["appendEvent"]>[1]) =>
    journal.appendEvent("run-r", event);
  emit({ type: "node-queued", instance: { siteId: "a", ordinal: 0 }, kind: "ask", actor: { siteId: "a", ordinal: 0 }, actorSeq: 0 } as never);
  emit({ type: "node-settled", instance: { siteId: "a", ordinal: 0 }, outcome: "ok", cached: true } as never);
  emit({ type: "node-queued", instance: { siteId: "r", ordinal: 1 }, kind: "report" } as never);
  emit({ type: "node-settled", instance: { siteId: "r", ordinal: 1 }, outcome: "ok" } as never);
  emit({ type: "node-queued", instance: { siteId: "w", ordinal: 2 }, kind: "world-read" } as never);
  emit({ type: "node-settled", instance: { siteId: "w", ordinal: 2 }, outcome: "ok" } as never);
  const order = recoverReplaySettleOrder(journal, "run-r");
  const released: string[] = [];
  order.hold("w@2", () => released.push("w@2"));
  order.hold("a@0", () => released.push("a@0"));
  assert.deepEqual(released, ["a@0", "w@0".replace("w@0", "w@2") === "w@2" ? "w@2" : "w@2"]);
});

// ———————————————————— 构建器：resolveInFlightAsk 四道门 ————————————————————

function fixtureJournal(): InMemoryJournalStore {
  const journal = new InMemoryJournalStore();
  journal.createRun({
    runId: "run-p",
    caps: { maxConcurrency: 1 },
    spentTokens: 0,
    status: "stopped",
  });
  journal.putActor({
    runId: "run-p",
    siteId: "a",
    ordinal: 0,
    name: "reviewer",
    persona: { name: "reviewer" },
    sessionId: "sess-a",
  });
  journal.putNode({
    runId: "run-p",
    siteId: "a",
    ordinal: 0,
    kind: "ask",
    actorSiteId: "a",
    actorOrdinal: 0,
    actorSeq: 0,
    inputHash: "h0",
    status: "completed",
    result: "r0",
    messageBoundary: 2,
    stats: { worldToolCalls: 0 },
  });
  journal.putNode({
    runId: "run-p",
    siteId: "a",
    ordinal: 1,
    kind: "ask",
    actorSiteId: "a",
    actorOrdinal: 0,
    actorSeq: 1,
    inputHash: "h1",
    status: "running",
  });
  return journal;
}

function transcriptsOf(count: number): { messages(): Promise<unknown[]> } {
  return { messages: async () => Array.from({ length: count }) };
}

test("构建器：四门全过 → inFlight 收下（全量消息数为边界）", async () => {
  const built = await buildImportedCache(
    {
      journal: fixtureJournal(),
      // biome-ignore lint: 测试桩只需要 messages 一面
      actorTranscriptStore: transcriptsOf(5) as never,
    },
    "run-p",
    { quietSessions: new Set(["sess-a"]) },
  );
  assert.equal(built.ok, true);
  const cand = built.ok ? built.cache.actors.get("reviewer") : undefined;
  assert.ok(cand);
  assert.equal(cand.entries.length, 1);
  assert.deepEqual(cand.inFlight, { inputHash: "h1", messageBoundary: 5 });
});

test("构建器：Q3 源未静默 / Q4 转录未过前缀 → 丢弃在飞（完结前缀照收）", async () => {
  const notQuiet = await buildImportedCache(
    {
      journal: fixtureJournal(),
      actorTranscriptStore: transcriptsOf(5) as never,
    },
    "run-p",
    { quietSessions: new Set() },
  );
  assert.ok(notQuiet.ok);
  assert.equal(notQuiet.ok ? notQuiet.cache.actors.get("reviewer")?.inFlight : undefined, undefined);
  assert.equal(notQuiet.ok ? notQuiet.cache.actors.get("reviewer")?.entries.length : 0, 1);

  const noGrowth = await buildImportedCache(
    {
      journal: fixtureJournal(),
      actorTranscriptStore: transcriptsOf(2) as never,
    },
    "run-p",
    { quietSessions: new Set(["sess-a"]) },
  );
  assert.ok(noGrowth.ok);
  assert.equal(noGrowth.ok ? noGrowth.cache.actors.get("reviewer")?.inFlight : undefined, undefined);
});
