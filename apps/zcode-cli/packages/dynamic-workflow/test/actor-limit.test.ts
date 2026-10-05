// 0C-1②（升级实施手册）：actor 数量创建门。调度器的 maxConcurrency 只压在飞派发，
// 挡不住脚本先把无限多 actor（各含一条子代理会话）注册出来——创建超限必须 run 级拒绝
//（与 DuplicateActorName 同姿态：failRun + 同步抛，模型可改脚本复用既有 actor）。
import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowEngine } from "../src/engine/engine.js";
import { DEFAULT_MAX_ACTORS } from "../src/engine/caps.js";
import { InMemoryJournalStore } from "../src/engine/journal-memory.js";
import type { Caps, RunEvent, WorkflowDriver } from "../src/engine/types.js";

function makeEngine(caps: Caps) {
  const journal = new InMemoryJournalStore();
  const emitted: RunEvent[] = [];
  const driver = { journal, emit: (event: RunEvent) => emitted.push(event) } as unknown as WorkflowDriver;
  const engine = new WorkflowEngine({
    runId: "run-actor-limit",
    driver,
    caps,
    askSpecs: new Map(),
    validate: (() => true) as never,
  });
  return { engine, journal };
}

test("创建门：超限 createActor 抛 ActorLimitExceeded 且 run 失败", () => {
  const { engine } = makeEngine({ maxConcurrency: 2, maxActors: 3 });
  engine.createActor("site-a", "a1");
  engine.createActor("site-a", "a2");
  engine.createActor("site-b", "a3");
  assert.throws(
    () => engine.createActor("site-b", "a4"),
    (error: { code?: string; message?: string }) => error?.code === "ActorLimitExceeded",
    "第 4 个 actor 必须被创建门拒绝",
  );
  assert.equal(engine.runSettled, true, "超限是 run 级拒绝（failRun）");
});

test("创建门：上限内照常创建（真实扇出不受限）", () => {
  const { engine } = makeEngine({ maxConcurrency: 2, maxActors: 5 });
  for (let index = 0; index < 5; index += 1) {
    engine.createActor("site-a", `actor-${index}`);
  }
  assert.equal(engine.runSettled, false);
});

test("缺省上限：DEFAULT_MAX_ACTORS 容纳真实扇出（Orca 参照 39 agent）且为有限值", () => {
  assert.ok(Number.isFinite(DEFAULT_MAX_ACTORS));
  assert.ok(DEFAULT_MAX_ACTORS >= 64);
  assert.ok(DEFAULT_MAX_ACTORS <= 512, "上限是护栏不是配额——不得低于真实大规模扇出需求");
});
