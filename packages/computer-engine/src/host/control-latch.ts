// FreeCodeZ W-17：kill switch/租约骨架（FC 自有，非 orca 派生）。
// W-25 在此之上收口全量策略链（request_access/stop 豁免面细化、settle 台账、
// possibly_sent 信封）。本骨架先行提供三件：①stop 闩锁（幂等、豁免面）；
// ②controller 租约（busy 拒绝接口，never-retry 语义位）；③cancel 通道。

export type ControlRejectCode = "control_stopped" | "controller_busy" | "cancelled";

export class ControlLatchError extends Error {
  readonly code: ControlRejectCode;
  constructor(code: ControlRejectCode, message: string) {
    super(message);
    this.name = "ControlLatchError";
    this.code = code;
  }
}

/** 豁免面：stop 自身与 request_access 探测不受闩锁/租约拦截（G.1 语义）。 */
const LATCH_EXEMPT_METHODS = new Set(["stop", "request_access", "permissionsStatus", "capabilities"]);

export interface ControlLease {
  readonly sessionId: string;
  readonly turnId: string | undefined;
  readonly signal: AbortSignal;
}

/**
 * 会话级控制闩锁 + controller 租约骨架。
 * - stop：闩下后所有非豁免方法立即拒 control_stopped；重复 stop 幂等。
 * - 租约：同一时刻只允许一个 controller 持有；未释放再申请 → controller_busy（never retry）。
 * - cancel：对当前租约的在途动作注入取消（动作侧经 lease.signal 观察）。
 */
export class ComputerControlGate {
  private stopped = false;
  private stopReason: string | undefined;
  private lease: ControlLease | undefined;
  private leaseAbort: AbortController | undefined;

  get isStopped(): boolean {
    return this.stopped;
  }

  get currentLease(): ControlLease | undefined {
    return this.lease;
  }

  /** stop_computer_control：幂等闩锁。返回生效原因（首次=入参原因，重复=首闩原因）。 */
  stop(reason: string): { stopped: true; reason: string } {
    if (!this.stopped) {
      this.stopped = true;
      this.stopReason = reason;
      this.leaseAbort?.abort(new ControlLatchError("control_stopped", reason));
    }
    return { stopped: true, reason: this.stopReason ?? reason };
  }

  /** 闩锁预检：非豁免方法在闩下时拒 control_stopped。 */
  assertMethodAllowed(method: string): void {
    if (this.stopped && !LATCH_EXEMPT_METHODS.has(method)) {
      throw new ControlLatchError(
        "control_stopped",
        `computer control stopped: ${this.stopReason ?? "stopped by controller"}`,
      );
    }
  }

  /** 租约申请：已有租约且非同持有者 → controller_busy（骨架：W-25 补 session+turn 归属细则）。 */
  acquireLease(sessionId: string, turnId: string | undefined): ControlLease {
    this.assertMethodAllowed("acquireLease");
    if (this.lease) {
      throw new ControlLatchError(
        "controller_busy",
        `computer control lease held by session ${this.lease.sessionId}` +
          (this.lease.turnId ? ` turn ${this.lease.turnId}` : ""),
      );
    }
    const abort = new AbortController();
    const lease: ControlLease = { sessionId, turnId, signal: abort.signal };
    this.lease = lease;
    this.leaseAbort = abort;
    return lease;
  }

  /** 租约释放：幂等；仅持有者可释放（骨架：W-25 补归属裁决）。 */
  releaseLease(lease: ControlLease): void {
    if (this.lease === lease) {
      this.lease = undefined;
      this.leaseAbort = undefined;
    }
  }

  /** cancel 通道：取消当前租约的在途动作。无租约时为 no-op。 */
  cancel(reason: string): void {
    this.leaseAbort?.abort(new ControlLatchError("cancelled", reason));
  }
}
