// 批次 2-1 retune 引擎单测：原地改并发上限的语义不变量（规格 R3 / 验收 A1 的引擎层）。
// - runId 不变、caps 列落库（journal 为事实源）、发 run-caps-changed 事件（带 previous）
// - 同值幂等（不落库不发声）；终态/非有限值拒绝
// - 在飞 ask 不动（本测试不建 actor，调度面由 routing 切片的集成测试覆盖）
import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowEngine } from "../src/engine/engine.js";
import { InMemoryJournalStore } from "../src/engine/journal-memory.js";
import type { Caps, RunEvent, WorkflowDriver } from "../src/engine/types.js";

function makeEngine(caps: Caps = { maxConcurrency: 2 }) {
  const journal = new InMemoryJournalStore();
  const emitted: RunEvent[] = [];
  const driver = {
    journal,
    emit: (event: RunEvent) => emitted.push(event),
  } as unknown as WorkflowDriver;
  const engine = new WorkflowEngine({
    runId: "run-retune",
    driver,
    caps,
    askSpecs: new Map(),
    validate: (() => true) as never,
  });
  return { engine, journal, emitted };
}

function capsChangedEvents(rows: { event: RunEvent }[]): RunEvent[] {
  return rows.map((row) => row.event).filter((event) => event.type === "run-caps-changed");
}

test("retune：cap 落库 + run-caps-changed 事件（带 previous），runId 不变", () => {
  const { engine, journal, emitted } = makeEngine({ maxConcurrency: 2 });
  assert.equal(engine.setMaxConcurrency(4), true);
  assert.equal(journal.getRun("run-retune")?.caps.maxConcurrency, 4);
  const journalEvents = capsChangedEvents(journal.listEvents("run-retune"));
  assert.equal(journalEvents.length, 1);
  const liveEvents = capsChangedEvents(emitted.map((event) => ({ event })));
  assert.equal(liveEvents.length, 1);
  const event = journalEvents[0] as { caps: Caps; previous: number };
  assert.equal(event.caps.maxConcurrency, 4);
  assert.equal(event.previous, 2);
});

test("retune：降档同样生效（只影响后续派发，事件照发）", () => {
  const { engine, journal } = makeEngine({ maxConcurrency: 8 });
  assert.equal(engine.setMaxConcurrency(1), true);
  assert.equal(journal.getRun("run-retune")?.caps.maxConcurrency, 1);
  assert.equal(capsChangedEvents(journal.listEvents("run-retune")).length, 1);
});

test("retune：同值幂等（true 且不落库不发声）", () => {
  const { engine, journal } = makeEngine({ maxConcurrency: 3 });
  assert.equal(engine.setMaxConcurrency(3), true);
  assert.equal(capsChangedEvents(journal.listEvents("run-retune")).length, 0);
  assert.equal(journal.getRun("run-retune")?.caps.maxConcurrency, 3);
});

test("retune：非有限值拒绝；终态拒绝（workflow_run_settled 的引擎层来源）", () => {
  const { engine, journal } = makeEngine({ maxConcurrency: 2 });
  assert.equal(engine.setMaxConcurrency(Number.NaN), false);
  assert.equal(engine.setMaxConcurrency(Number.POSITIVE_INFINITY), false);
  engine.complete("done");
  assert.equal(engine.setMaxConcurrency(4), false);
  assert.equal(capsChangedEvents(journal.listEvents("run-retune")).length, 0);
  assert.equal(journal.getRun("run-retune")?.caps.maxConcurrency, 2);
});
