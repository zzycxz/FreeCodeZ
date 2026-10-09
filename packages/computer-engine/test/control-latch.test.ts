// FreeCodeZ W-17 骨架单测：stop 闩锁/busy 拒绝/cancel 通道与豁免面。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ComputerControlGate, ControlLatchError } from "../src/host/control-latch";

describe("ComputerControlGate (W-17 skeleton)", () => {
  it("stop 幂等闩锁：非豁免方法拒 control_stopped，request_access/stop 豁免", () => {
    const gate = new ComputerControlGate();
    const first = gate.stop("user pressed Esc");
    const second = gate.stop("another reason");
    assert.strictEqual(first.reason, "user pressed Esc");
    assert.strictEqual(second.reason, "user pressed Esc", "重复 stop 返回首闩原因（幂等）");
    assert.throws(
      () => gate.assertMethodAllowed("click"),
      (error: unknown) => error instanceof ControlLatchError && error.code === "control_stopped",
    );
    gate.assertMethodAllowed("request_access");
    gate.assertMethodAllowed("stop");
  });

  it("controller 租约：互斥申请拒 controller_busy，释放后可再申请", () => {
    const gate = new ComputerControlGate();
    const lease = gate.acquireLease("session-a", "turn-1");
    assert.throws(
      () => gate.acquireLease("session-b", "turn-2"),
      (error: unknown) => error instanceof ControlLatchError && error.code === "controller_busy",
    );
    gate.releaseLease(lease);
    const again = gate.acquireLease("session-b", "turn-2");
    assert.strictEqual(again.sessionId, "session-b");
  });

  it("cancel 通道：中止在途租约信号，且 stop 也中止并带 control_stopped", () => {
    const gate = new ComputerControlGate();
    const lease = gate.acquireLease("session-a", undefined);
    let observed: unknown;
    lease.signal.addEventListener("abort", () => {
      observed = lease.signal.reason;
    });
    gate.cancel("user cancelled");
    assert.ok(observed instanceof ControlLatchError && observed.code === "cancelled");

    const gate2 = new ComputerControlGate();
    const lease2 = gate2.acquireLease("session-a", undefined);
    let observed2: unknown;
    lease2.signal.addEventListener("abort", () => {
      observed2 = lease2.signal.reason;
    });
    gate2.stop("Esc");
    assert.ok(observed2 instanceof ControlLatchError && observed2.code === "control_stopped");
    assert.strictEqual(gate2.isStopped, true);
  });
});
