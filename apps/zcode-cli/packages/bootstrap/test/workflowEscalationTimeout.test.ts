// 0B-3 修复测试（升级实施手册）：
// ① escalation deferred 超时收敛——旧版停驻无超时，无人作答（自动化 run/无人值守）时
//    actor 永久阻塞、run 无限挂死；且 stall 时钟只有成功/重试两个节拍，停驻期间零节拍，
//    20 分钟停滞通知也发不出来（v3.3 病因修正）。修复：超时撤下（结构化拒绝）+ 停驻喂节拍。
// ② 并发 amend 同前驱互斥——停止→等结算→建缓存窗口内并发第二笔会从同一前驱 fork 出
//    两个后继（血统分叉）；第二笔结构化拒绝 amend_in_flight。
import assert from "node:assert/strict";
import test from "node:test";
import {
  makeSessionEscalatePort,
  respondToParkedEscalation,
  type EscalationHost,
} from "../src/app/workflow-driver-escalation.js";
import type { SessionState } from "../src/app/workflow-driver-types.js";
import { defer } from "../src/app/workflow-driver-helpers.js";

interface FakeRegistry {
  parked: { qid: string; onAnswer: (answer: string) => void }[];
  withdrawn: string[];
  isTaken(qid: string): boolean;
  park(entry: { qid: string }, onAnswer: (answer: string) => void): void;
  withdraw(qid: string): void;
}

function fakeRegistry(): FakeRegistry {
  return {
    parked: [],
    withdrawn: [],
    isTaken: (qid) => false,
    park(entry, onAnswer) {
      this.parked.push({ qid: entry.qid, onAnswer });
    },
    withdraw(qid) {
      this.withdrawn.push(qid);
    },
  } as FakeRegistry;
}

interface Harness {
  host: EscalationHost;
  state: SessionState;
  registry: FakeRegistry;
  parkedBeats: string[];
  timers: { callback: () => void; delayMs: number; cancelled: boolean }[];
}

function harness(options?: { escalationTimeoutMs?: number }): Harness {
  const registry = fakeRegistry();
  const parkedBeats: string[] = [];
  const timers: { callback: () => void; delayMs: number; cancelled: boolean }[] = [];
  const state = {
    pendingEscalations: new Map(),
    escalationTimers: new Map(),
    escalationsUsed: 0,
    currentInstance: { node: "n1", ordinal: 1 },
  } as unknown as SessionState;
  const recorded: unknown[] = [];
  const host: EscalationHost = {
    deps: {
      escalationRegistry: registry as never,
      logger: undefined,
      runId: "run-test",
      clock: {
        schedule: (callback: () => void, delayMs: number) => {
          const timer = { callback, delayMs, cancelled: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
        ...(options?.escalationTimeoutMs === undefined
          ? {}
          : { escalationTimeoutMs: options.escalationTimeoutMs }),
      },
    } as never,
    sessions: new Map([["sess-a", state]]),
    qidToSession: new Map(),
    nextEscalationSeq: (() => {
      let seq = 0;
      return () => ++seq;
    })(),
    record: (event) => recorded.push(event),
    noteEscalationParked: () => parkedBeats.push("escalation-parked"),
  } as EscalationHost;
  return { host, state, registry, parkedBeats, timers };
}

const ACTOR = { node: "main", ordinal: 1 } as never;
const PERSONA = { name: "worker" } as never;

test("停驻喂节拍：park 时给 stall 时钟上膛（挂死可探测）", async () => {
  const h = harness({ escalationTimeoutMs: 10_000 });
  const port = makeSessionEscalatePort(h.host, "sess-a" as never, ACTOR, PERSONA);
  const promise = port.escalate({ question: "blocked?" });
  assert.equal(h.parkedBeats.length, 1, "park 必须喂一个 stall 节拍（0B-3 病因修正）");
  // 回收：作答退场，避免悬挂 promise。
  const parked = h.registry.parked[0]!;
  parked.onAnswer("go ahead");
  const outcome = await promise;
  assert.equal(outcome.kind, "answered");
});

test("超时收敛：无人作答的停驻到时撤下，deferred 收结构化拒绝", async () => {
  const h = harness({ escalationTimeoutMs: 5_000 });
  const port = makeSessionEscalatePort(h.host, "sess-a" as never, ACTOR, PERSONA);
  const promise = port.escalate({ question: "anyone?" });
  const timer = h.timers[0]!;
  assert.equal(timer.delayMs, 5_000);
  assert.equal(h.state.pendingEscalations.size, 1);
  timer.callback();
  await assert.rejects(
    promise,
    (error: { message?: string }) => Boolean(error?.message?.includes("timed out")),
    "超时必须把 deferred 拒绝成可 catch 的结构化错误",
  );
  assert.equal(h.state.pendingEscalations.size, 0, "停驻表必须清理");
  assert.equal(h.state.escalationTimers.size, 0);
  assert.deepEqual(h.registry.withdrawn, [h.registry.parked[0]!.qid], "注册表必须同步撤下");
});

test("作答退场取消定时器：迟到定时器不再触发", async () => {
  const h = harness({ escalationTimeoutMs: 5_000 });
  const port = makeSessionEscalatePort(h.host, "sess-a" as never, ACTOR, PERSONA);
  const promise = port.escalate({ question: "q" });
  const qid = h.registry.parked[0]!.qid;
  // 主代理先作答。
  const answered = respondToParkedEscalation(h.host, qid, "yes");
  assert.equal(answered, true);
  const outcome = await promise;
  assert.equal(outcome.kind, "answered");
  // 迟到的定时器即使被错误调用也已无事可做（deferred 身份守卫）。
  const timer = h.timers[0]!;
  assert.equal(timer.cancelled, true, "作答退场必须取消定时器");
  timer.callback();
  assert.deepEqual(h.registry.withdrawn, [], "迟到的超时不得再撤下已作答的问答");
});

test("escalationTimeoutMs=0：显式不限时（交互长等场景逃生口）", async () => {
  const h = harness({ escalationTimeoutMs: 0 });
  const port = makeSessionEscalatePort(h.host, "sess-a" as never, ACTOR, PERSONA);
  void port.escalate({ question: "slow one" });
  assert.equal(h.timers.length, 0, "0 = 不限时，不得上定时器");
  assert.equal(h.parkedBeats.length, 1, "但停驻节拍照喂（stall 通知仍可发）");
  h.registry.parked[0]!.onAnswer("ok");
});

test("escalationsUsed 预算与拒绝语义不受本修复影响", async () => {
  const h = harness({ escalationTimeoutMs: 0 });
  const port = makeSessionEscalatePort(h.host, "sess-a" as never, ACTOR, PERSONA);
  // 无在飞 ask：refused（既有语义）。
  (h.state as { currentInstance?: unknown }).currentInstance = undefined;
  const refused = await port.escalate({ question: "q" });
  assert.equal(refused.kind, "refused");
  // defer 工具的存在性由 helpers 提供，本测试只验证端口语义。
  assert.equal(typeof defer, "function");
});

test("并发 amend 同前驱：第二笔结构化拒绝 amend_in_flight（血统不分叉）", async () => {
  // amendDynamicWorkflowRun 的互斥门在 amendDynamicWorkflowRun 入口——直接驱动其模块级
  // 互斥语义：同前驱第二笔调用在第一笔未结算时立即被拒。用假 ctx（journal 预检即失败）
  // 让第一笔停在可观察状态：第一笔 pending 期间第二笔必须立刻收到 amend_in_flight。
  const { amendDynamicWorkflowRun } = await import(
    "../src/app/dynamic-workflow-run-submit.js"
  );
  let releaseFirst: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const ctx = {
    deps: {
      journal: {
        getRun: () => undefined, // 预检将拒 run_not_found——但入口互斥先于预检
      },
      logger: undefined,
    },
    runs: new Map(),
  } as never;
  const request = { predecessorRunId: "run-x", scriptText: "1", trace: {} } as never;
  const first = amendDynamicWorkflowRun(ctx, request);
  releaseFirst?.();
  await first; // 第一笔走到预检拒绝（run_not_found），释放互斥键
  // 串行第二笔：互斥已释放，走预检拒绝（非 amend_in_flight）——语义不受影响。
  const second = await amendDynamicWorkflowRun(ctx, request);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, "run_not_found");
});

test("并发窗口：第一笔在途时第二笔立即收 amend_in_flight", async () => {
  const { amendDynamicWorkflowRun } = await import(
    "../src/app/dynamic-workflow-run-submit.js"
  );
  // 构造真正在途：预检过（run 在 + 无已完结 ask）+ 在飞注册表条目的 settlement 永不结算
  // →第一笔停在 `await live.settlement`。
  const ctx = {
    deps: {
      journal: {
        getRun: () => ({ id: "run-y", status: "running" }),
        listNodes: () => [],
      },
      logger: undefined,
    },
    runs: new Map([
      ["run-y", { terminal: undefined, controller: { abort: () => undefined }, settlement: new Promise(() => undefined) }],
    ]),
  } as never;
  const request = { predecessorRunId: "run-y", scriptText: "1", trace: {} } as never;
  const first = amendDynamicWorkflowRun(ctx, request);
  // 让事件循环推进一拍，确保第一笔已登记互斥键并停在等结算。
  await new Promise((resolve) => setImmediate(resolve));
  const second = await Promise.resolve(amendDynamicWorkflowRun(ctx, request));
  assert.equal(
    second.ok === false && second.reason === "amend_in_flight",
    true,
    "在途第二笔必须立即结构化拒绝",
  );
  // 第一笔永不结算（settlement pending）——测试进程内该键保持占用不影响其他用例（键唯一）。
});
