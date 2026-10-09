// W-26 决策表测试平移（自 zcode-cua/test/user-activity-gate.test.mjs，语义等价）：
// 决策表四形态 + 等待循环两路径 + 装饰器三性质 + 缺省形状。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  USER_ACTIVITY_GATE_DEFAULTS,
  createUserActivityReader,
  userActivityGateDecision,
  waitForUserQuiet,
  wrapMethodsWithActivityGate,
} from "../src/host/user-activity-gate";

describe("user activity gate (W-26)", () => {
  it("决策表：静默放行 / 活跃等待 / 等满失败 / 检测器缺席放行", () => {
    const opts = { thresholdMs: 800, maxWaitMs: 30_000 };
    assert.equal(userActivityGateDecision(800, 0, opts), "proceed");
    assert.equal(userActivityGateDecision(60_000, 0, opts), "proceed");
    assert.equal(userActivityGateDecision(100, 0, opts), "wait");
    assert.equal(userActivityGateDecision(799, 29_999, opts), "wait");
    assert.equal(userActivityGateDecision(100, 30_000, opts), "fail");
    assert.equal(userActivityGateDecision(undefined, 0, opts), "proceed");
  });

  it("等待循环：活跃转静默后放行；持续活跃到上限返回结构化 user_active", async () => {
    let reads = 0;
    const turnsQuiet = () => {
      reads += 1;
      return { userActive: reads <= 2, lastMoveMs: reads <= 2 ? 50 : 5_000 };
    };
    const pass = await waitForUserQuiet(turnsQuiet, { thresholdMs: 800, pollMs: 1, maxWaitMs: 1_000 });
    assert.equal(pass.ok, true);
    assert.equal(reads, 3);

    const alwaysActive = () => ({ userActive: true, lastMoveMs: 10 });
    const fail = await waitForUserQuiet(alwaysActive, { thresholdMs: 800, pollMs: 1, maxWaitMs: 20 });
    assert.equal(fail.ok, false);
    if (!fail.ok) {
      assert.equal(fail.error.code, "user_active");
      assert.equal(typeof fail.error.details.waited_ms, "number");
      assert.equal(fail.error.details.last_move_ms, 10);
    }
  });

  it("装饰器：names 过滤、闸门失败不执行本体、放行透传参数与结果", async () => {
    const calls: unknown[] = [];
    const methods: Record<string, unknown> = {
      click: async (params: unknown) => {
        calls.push(["click", params]);
        return { ok: true, action_sent: true };
      },
      list_applications: async () => {
        calls.push(["list_applications"]);
        return { ok: true, apps: [] };
      },
    };
    wrapMethodsWithActivityGate(
      methods,
      ["click", "drag", "list_applications"],
      () => ({ userActive: true, lastMoveMs: 5 }),
      { thresholdMs: 800, pollMs: 1, maxWaitMs: 10 },
    );
    const blocked = (await (methods.click as (p: unknown) => Promise<unknown>)({ point: [1, 2] })) as {
      ok: boolean;
      error: { code: string };
    };
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, "user_active");
    assert.deepEqual(calls, [], "闸门失败时动作本体不得执行");
    assert.equal(methods.drag, undefined);

    const quiet = () => ({ userActive: false, lastMoveMs: 9_000 });
    const methods2: Record<string, unknown> = {
      click: async (params: unknown) => ({ ok: true, echoed: params }),
    };
    wrapMethodsWithActivityGate(methods2, ["click"], quiet, { thresholdMs: 800, pollMs: 1 });
    const passed = (await (methods2.click as (p: unknown) => Promise<unknown>)({ point: [3, 4] })) as unknown;
    assert.deepEqual(passed, { ok: true, echoed: { point: [3, 4] } });
  });

  it("缺省参数与读取器工厂形状", () => {
    assert.equal(USER_ACTIVITY_GATE_DEFAULTS.thresholdMs, 800, "静默阈值与 HUD 同值");
    assert.ok(USER_ACTIVITY_GATE_DEFAULTS.maxWaitMs >= 10_000, "持续活跃等待上限须有界且够长");
    const reader = createUserActivityReader(undefined);
    assert.deepEqual(reader(), { userActive: false, lastMoveMs: undefined });
  });
});
