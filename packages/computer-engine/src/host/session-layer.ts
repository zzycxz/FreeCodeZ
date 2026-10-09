// FreeCodeZ W-25：会话层策略链（FC 自有，代码与测试全新编写；行为语义清单继承自旧栈
// tool-runtime.test.mjs 的功能需求——R5 kill switch/R4 租约/R3 双拒/possibly_sent 归一/
// CUA_NOT_READY 信封，实现与文案不参考任何第三方产物）。
// G.3 划分：本层持有 kill switch 闩锁、controller 租约（session+turn 归属）、
// settle 台账（同目标串行+静默窗）、信封归一；引擎保持无状态（R5）。
import { ComputerControlGate, ControlLatchError } from "./control-latch";
import { ComputerUseSdkError, mapEngineError, type SdkErrorMapping } from "../sdk/errors";

export type AgentKind = "main" | "subagent";

export interface SessionLayerOptions {
  sessionId: string;
  /** subagent 双拒面：subagent 上下文一律拒绝电脑控制（R3）。 */
  agentKind?: AgentKind;
  /** settle 静默窗：同目标相邻动作之间的最小间隔（毫秒）；缺省 0（仅串行）。 */
  settleWindowMs?: number;
}

export interface ControlEnvelope {
  code: string;
  retry: "reobserve" | "never" | "retry";
  /** possibly_sent：动作可能已送达——禁止自动重放（W-25 信封核心语义）。 */
  possiblySent: boolean;
  /** 非重放面：possibly_sent 或 never 类动作的后续自动重放一律拒绝。 */
  replayable: boolean;
  message: string;
}

export interface TurnLease {
  readonly sessionId: string;
  readonly turnId: string;
}

/**
 * 会话层：闩锁/租约/settle/双拒/信封的统一入口。
 * 租约归属 = (sessionId, turnId)：同持有者可续（幂等），他者 controller_busy（never-retry）。
 */
export class ComputerSessionLayer {
  readonly gate = new ComputerControlGate();
  private readonly sessionId: string;
  private readonly agentKind: AgentKind;
  private readonly settleWindowMs: number;
  private lease: TurnLease | undefined;
  private settleChains = new Map<string, Promise<unknown>>();
  private lastActionAt = new Map<string, number>();
  private replayDenied = new Set<string>();

  constructor(options: SessionLayerOptions) {
    this.sessionId = options.sessionId;
    this.agentKind = options.agentKind ?? "main";
    this.settleWindowMs = options.settleWindowMs ?? 0;
  }

  // ---- R3 subagent 双拒：注册面 + 执行面两处拒绝 ----

  /** 拒绝点 1（注册面）：subagent 上下文不得取得会话层。 */
  assertControllerContext(): void {
    if (this.agentKind === "subagent") {
      throw new ComputerUseSdkError(
        { sdkCode: "INVALID_REQUEST", retry: "never", possiblySent: false },
        "computer control is not available in subagent",
      );
    }
  }

  // ---- R4 单控制器租约（session+turn 归属）----

  acquireTurn(turnId: string): TurnLease {
    this.assertControllerContext(); // 拒绝点 2（执行面）
    if (this.lease && (this.lease.sessionId !== this.sessionId || this.lease.turnId !== turnId)) {
      throw new ControlLatchError(
        "controller_busy",
        `computer control lease held by session ${this.lease.sessionId} turn ${this.lease.turnId}`,
      );
    }
    this.lease = { sessionId: this.sessionId, turnId };
    return this.lease;
  }

  releaseTurn(lease: TurnLease): void {
    if (this.lease && this.lease.sessionId === lease.sessionId && this.lease.turnId === lease.turnId) {
      this.lease = undefined;
    }
  }

  // ---- settle 台账：同目标串行 + 静默窗 ----

  /** 同一 targetKey 的动作严格串行；相邻动作间保持 settleWindowMs 静默窗。 */
  async settled<T>(targetKey: string, action: () => Promise<T>): Promise<T> {
    this.assertControllerContext();
    const previous = this.settleChains.get(targetKey) ?? Promise.resolve();
    const run = previous.then(async () => {
      const last = this.lastActionAt.get(targetKey);
      if (last !== undefined && this.settleWindowMs > 0) {
        const wait = this.settleWindowMs - (Date.now() - last);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }).then(action);
    this.settleChains.set(
      targetKey,
      run.catch(() => undefined),
    );
    try {
      return await run;
    } finally {
      this.lastActionAt.set(targetKey, Date.now());
    }
  }

  // ---- W-25 信封归一：CUA_NOT_READY 类 + possibly_sent 不自动重放 ----

  /** 引擎错误 → 控制信封；possibly_sent/never 类登记非重放面。 */
  normalizeEnvelope(source: string | undefined, message: string, actionKey?: string): ControlEnvelope {
    const mapping: SdkErrorMapping = mapEngineError(source ?? "invalid_argument", message);
    const envelope: ControlEnvelope = {
      code: mapping.sdkCode,
      retry: mapping.retry,
      possiblySent: mapping.possiblySent,
      replayable: !mapping.possiblySent && mapping.retry !== "never",
      message,
    };
    if (!envelope.replayable && actionKey !== undefined) {
      this.replayDenied.add(actionKey);
    }
    return envelope;
  }

  /** 非重放面复核：被登记过的动作（possibly_sent/never）拒绝自动重放。 */
  assertReplayable(actionKey: string): void {
    if (this.replayDenied.has(actionKey)) {
      throw new ComputerUseSdkError(
        { sdkCode: "TIMEOUT", retry: "never", possiblySent: true },
        `action ${actionKey} may already have been delivered; re-observe before any manual retry`,
      );
    }
  }
}
