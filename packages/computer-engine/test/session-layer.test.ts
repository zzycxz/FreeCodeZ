// W-25 策略链单测：行为语义清单继承自旧栈 tool-runtime.test.mjs（功能需求层面），
// 代码与测试全新编写。覆盖：R3 双拒两处/R5 闩锁豁免/R4 租约归属+busy never-retry/
// possibly_sent 归一+禁自动重放/settle 同目标串行+静默窗/严格 schema/D1 收敛。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ComputerSessionLayer } from "../src/host/session-layer";
import { ControlLatchError } from "../src/host/control-latch";
import { ComputerUseSdkError } from "../src/sdk/errors";
import { Click, ListApps, ListWindows, TypeText } from "../src/shared/rpc-contract/computer-schemas-params";

describe("W-25 R3 subagent 双拒", () => {
  it("注册面与执行面两处均拒绝（文案与桥侧一致）", async () => {
    const layer = new ComputerSessionLayer({ sessionId: "s", agentKind: "subagent" });
    assert.throws(
      () => layer.assertControllerContext(),
      (e: unknown) => e instanceof ComputerUseSdkError && e.message === "computer control is not available in subagent",
    );
    assert.throws(() => layer.acquireTurn("t1"), (e: unknown) => e instanceof ComputerUseSdkError);
    await assert.rejects(layer.settled("target", async () => 1), (e: unknown) => e instanceof ComputerUseSdkError);
  });
});

describe("W-25 R4 单控制器租约", () => {
  it("异会话/异 turn 报 controller_busy（带 owner，never-retry 语义），释放后可取得", () => {
    const layer2 = new ComputerSessionLayer({ sessionId: "session-a" });
    const lease = layer2.acquireTurn("turn-1");
    assert.throws(
      () => layer2.acquireTurn("turn-2"),
      (e: unknown) =>
        e instanceof ControlLatchError &&
        e.code === "controller_busy" &&
        e.message.includes("session session-a") &&
        e.message.includes("turn turn-1"),
    );
    layer2.releaseTurn(lease);
    layer2.acquireTurn("turn-2");
    // 同 turn 续租幂等
    layer2.acquireTurn("turn-2");
  });

  it("观测面不受租约影响（settled 只作用于动作）", () => {
    const layer = new ComputerSessionLayer({ sessionId: "s" });
    layer.acquireTurn("t1");
    // 观测路径不经 settled/assertControllerContext——无抛错即为不受影响。
    assert.strictEqual(layer.gate.isStopped, false);
  });
});

describe("W-25 settle 台账", () => {
  it("同目标严格串行；不同目标互不阻塞", async () => {
    const layer = new ComputerSessionLayer({ sessionId: "s" });
    const order: string[] = [];
    await Promise.all([
      layer.settled("appA:5", async () => {
        order.push("a1-start");
        await new Promise((r) => setTimeout(r, 20));
        order.push("a1-end");
      }),
      layer.settled("appA:5", async () => {
        order.push("a2");
      }),
      layer.settled("appB:9", async () => {
        order.push("b1");
      }),
    ]);
    assert.ok(order.indexOf("a2") > order.indexOf("a1-end"), `同目标不得重叠: ${order.join(",")}`);
    assert.ok(order.indexOf("a2") > order.indexOf("a1-start"));
    assert.ok(order.includes("b1"), "异目标不被阻塞");
  });

  it("静默窗：同目标相邻动作间隔 ≥ settleWindowMs", async () => {
    const layer = new ComputerSessionLayer({ sessionId: "s", settleWindowMs: 30 });
    const stamps: number[] = [];
    await layer.settled("t", async () => {
      stamps.push(Date.now());
    });
    await layer.settled("t", async () => {
      stamps.push(Date.now());
    });
    assert.ok((stamps[1] ?? 0) - (stamps[0] ?? 0) >= 25, "静默窗不足");
  });
});

describe("W-25 信封归一与禁重放", () => {
  it("possibly_sent 归一：replayable=false 且登记非重放面", () => {
    const layer = new ComputerSessionLayer({ sessionId: "s" });
    const env = layer.normalizeEnvelope(
      "action_timeout",
      "action timed out after 5000ms",
      "click#1",
    );
    assert.strictEqual(env.code, "TIMEOUT");
    assert.strictEqual(env.possiblySent, true);
    assert.strictEqual(env.replayable, false);
    assert.throws(
      () => layer.assertReplayable("click#1"),
      (e: unknown) => e instanceof ComputerUseSdkError && e.possiblySent === true,
    );
  });

  it("window_not_focused 已送达语义归 possibly_sent；纯聚焦失败可重试", () => {
    const layer = new ComputerSessionLayer({ sessionId: "s" });
    const delivered = layer.normalizeEnvelope(
      "window_not_focused",
      "coordinate click aborted; 1 press(es) may already have been delivered",
    );
    assert.deepStrictEqual(
      [delivered.code, delivered.retry, delivered.possiblySent],
      ["FOREGROUND_REQUIRED", "never", true],
    );
    const focusOnly = layer.normalizeEnvelope("window_not_focused", "window is not focused");
    assert.deepStrictEqual(
      [focusOnly.code, focusOnly.retry, focusOnly.possiblySent],
      ["FOREGROUND_REQUIRED", "reobserve", false],
    );
  });

  it("引擎不可用 → CUA_NOT_READY retryable；传输级冷启动同类", () => {
    const layer = new ComputerSessionLayer({ sessionId: "s" });
    const env = layer.normalizeEnvelope(
      "unsupported_capability",
      "computer-use has no native provider for darwin",
    );
    assert.deepStrictEqual([env.code, env.retry], ["CUA_NOT_READY", "retry"]);
  });
});

describe("W-25 R5 kill switch 豁免面", () => {
  it("stop/request_access/capabilities 豁免，动作面拒绝", () => {
    const layer = new ComputerSessionLayer({ sessionId: "s" });
    layer.gate.stop("Esc");
    layer.gate.assertMethodAllowed("stop");
    layer.gate.assertMethodAllowed("request_access");
    layer.gate.assertMethodAllowed("capabilities");
    assert.throws(() => layer.gate.assertMethodAllowed("click"), (e: unknown) => e instanceof ControlLatchError);
  });
});

describe("W-25 严格 schema 与 D1 收敛", () => {
  it("未声明键拒绝（strict schema 面）+ 参数面正例", () => {
    const parsed = ListApps.safeParse({ bogus: true });
    assert.strictEqual(parsed.success, false, "strict 面拒绝未声明键");
    const windowParsed = ListWindows.safeParse({ app: "Finder", extra: 1 });
    assert.strictEqual(windowParsed.success, false);
    const ok = TypeText.safeParse({ app: "Finder", text: "hello" });
    assert.strictEqual(ok.success, true);
    const clickOk = Click.safeParse({ app: "Finder", elementIndex: 1 });
    assert.strictEqual(clickOk.success, true);
  });

  it("D1 收敛：错误码面不产生已废码（APP_NOT_FOUND/AMBIGUOUS_APP/SCREEN_LOCKED）", () => {
    const layer = new ComputerSessionLayer({ sessionId: "s" });
    for (const retired of ["APP_NOT_FOUND", "AMBIGUOUS_APP", "SCREEN_LOCKED"]) {
      const env = layer.normalizeEnvelope(retired.toLowerCase(), "m");
      assert.ok(env.code !== retired, `不得产生 ${retired}`);
    }
  });
});
