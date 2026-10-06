// Phase 2 干预闭环（手册 v4.2 挂账收口）：动作面用户活动闸纯件测试。
// 决策表四形态 + 等待循环两路径（静默放行/超时结构化失败）+ 装饰器接线三性质
//（names 过滤、闸门失败不执行本体、放行后透传参数与结果）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  USER_ACTIVITY_GATE_DEFAULTS,
  createUserActivityReader,
  userActivityGateDecision,
  waitForUserQuiet,
  wrapMethodsWithActivityGate,
} from "../macos/user-activity-gate.js";

test("决策表：静默放行 / 活跃等待 / 等满失败 / 检测器缺席放行", () => {
  const opts = { thresholdMs: 800, maxWaitMs: 30_000 };
  // 已静默（lastMoveMs ≥ 阈值）→ 放行。
  assert.equal(userActivityGateDecision(800, 0, opts), "proceed");
  assert.equal(userActivityGateDecision(60_000, 0, opts), "proceed");
  // 用户活跃但未等满 → 等待。
  assert.equal(userActivityGateDecision(100, 0, opts), "wait");
  assert.equal(userActivityGateDecision(799, 29_999, opts), "wait");
  // 活跃且等满上限 → 失败（fail-closed，可重试不熔断）。
  assert.equal(userActivityGateDecision(100, 30_000, opts), "fail");
  // 检测器缺席（CG 调用异常等）→ 放行：干预面缺席不折断动作本体。
  assert.equal(userActivityGateDecision(undefined, 0, opts), "proceed");
});

test("等待循环：活跃转静默后放行；持续活跃到上限返回结构化 user_active", async () => {
  // 场景一：先活跃两拍，第三拍静默 → ok。
  let reads = 0;
  const turnsQuiet = () => {
    reads += 1;
    return { userActive: reads <= 2, lastMoveMs: reads <= 2 ? 50 : 5_000 };
  };
  const pass = await waitForUserQuiet(turnsQuiet, { thresholdMs: 800, pollMs: 1, maxWaitMs: 1_000 });
  assert.equal(pass.ok, true);
  assert.equal(reads, 3);

  // 场景二：恒活跃 → 等满上限 → 结构化错误（含 waited_ms 证据字段）。
  const alwaysActive = () => ({ userActive: true, lastMoveMs: 10 });
  const fail = await waitForUserQuiet(alwaysActive, { thresholdMs: 800, pollMs: 1, maxWaitMs: 20 });
  assert.equal(fail.ok, false);
  assert.equal(fail.error.code, "user_active");
  assert.equal(typeof fail.error.details.waited_ms, "number");
  assert.equal(fail.error.details.last_move_ms, 10);
});

test("装饰器：names 过滤、闸门失败不执行本体、放行透传参数与结果", async () => {
  const calls = [];
  const methods = {
    click: async (params) => {
      calls.push(["click", params]);
      return { ok: true, action_sent: true };
    },
    list_applications: async () => {
      calls.push(["list_applications"]);
      return { ok: true, apps: [] };
    },
  };
  // 闸门恒失败（短上限）→ 动作方法不执行本体，返回结构化错误。
  wrapMethodsWithActivityGate(
    methods,
    ["click", "drag", "list_applications"],
    () => ({ userActive: true, lastMoveMs: 5 }),
    { thresholdMs: 800, pollMs: 1, maxWaitMs: 10 },
  );
  const blocked = await methods.click({ point: [1, 2] });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "user_active");
  assert.deepEqual(calls, [], "闸门失败时动作本体不得执行");
  // 名单驱动：表内存在且在名单中的键被包装（是否包观测面由调用方名单决定，本件不越权）；
  // 名单中表内不存在的键（drag）跳过不炸、也不注入。
  assert.equal(methods.drag, undefined);

  // 闸门放行 → 参数透传、结果透传。
  const quiet = () => ({ userActive: false, lastMoveMs: 9_000 });
  const methods2 = {
    click: async (params) => ({ ok: true, echoed: params }),
  };
  wrapMethodsWithActivityGate(methods2, ["click"], quiet, { thresholdMs: 800, pollMs: 1 });
  const passed = await methods2.click({ point: [3, 4] });
  assert.deepEqual(passed, { ok: true, echoed: { point: [3, 4] } });
});

test("缺省参数与读取器工厂形状", () => {
  assert.equal(USER_ACTIVITY_GATE_DEFAULTS.thresholdMs, 800, "静默阈值与 HUD 同值");
  assert.ok(USER_ACTIVITY_GATE_DEFAULTS.maxWaitMs >= 10_000, "持续活跃等待上限须有界且够长");
  // bindings 缺失（非 darwin/无 koffi）→ 读取器返回检测器缺席形态（lastMoveMs undefined）。
  const reader = createUserActivityReader(undefined);
  assert.deepEqual(reader(), { userActive: false, lastMoveMs: undefined });
});
