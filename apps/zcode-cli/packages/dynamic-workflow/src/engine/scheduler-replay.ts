// ============================================================
// ReplaySettleOrder：崩溃恢复中缓存行结算的确定性放行序（批次 2-2 carry）
// ============================================================
// 从 scheduler.ts 拆出（max-lines 门）。3.14.0 的 replay 短路（releaseCachedAsk）在
// drainAdmission 里按 actorSeq 顺序同步结算——单 actor 内这恰好就是原次执行序；但一次崩溃
// 恢复里多个已完结行（跨 actor、跨 world/artifact）的 settle 事件序不再有约束，读面
// （投影 / 通知）会看到与原次执行不同的落地序。上游 3.14.3 用「按崩溃前记录的结算事件序
// 放行」收口：恢复时从 journal 事件重建这张序表，replay 的缓存结算逐位放行；run 结算时
// open() 清空剩余（终局不因停驻而死锁）。
// 携带 ask（批次 2-2 主体）是 live 准入，不经这里——本模块只管**已记录行**的回放结算。

import type { JournalStorePort } from "./types.js";
import { refToString } from "./types.js";

/** 停驻-放行序表：未知或已过位的实例立即结算，其余停驻到自己的位次。 */
export class ReplaySettleOrder {
  private readonly order: readonly string[];
  private readonly position: ReadonlyMap<string, number>;
  private cursor = 0;
  private opened = false;
  private readonly parked = new Map<string, () => void>();

  constructor(order: readonly string[] = []) {
    this.order = order;
    this.position = new Map(order.map((key, index) => [key, index]));
  }

  static empty(): ReplaySettleOrder {
    return new ReplaySettleOrder([]);
  }

  hold(key: string, settle: () => void): void {
    if (this.opened) {
      settle();
      return;
    }
    const pos = this.position.get(key);
    if (pos === undefined || pos < this.cursor) {
      settle();
      return;
    }
    this.parked.set(key, settle);
    this.pump();
  }

  /** run 结算（含失败/取消）：放行全部停驻——终局优先于序表，绝不停驻到死。 */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    for (const settle of this.parked.values()) settle();
    this.parked.clear();
  }

  private pump(): void {
    for (;;) {
      const next = this.order[this.cursor];
      if (next === undefined || !this.parked.has(next)) break;
      const settle = this.parked.get(next)!;
      this.parked.delete(next);
      this.cursor++;
      settle();
    }
  }
}

/**
 * 从 journal 事件重建序表：**会索赔回放的行**（ask / world / 非 report 的 artifact）的
 * `node-settled` 出现序。kind 从 `node-queued` 事件查（settle 事件本身不带 kind）；
 * report 不入表——它不短路回放，永远现场重发。
 */
export function recoverReplaySettleOrder(
  journal: JournalStorePort,
  runId: string,
): ReplaySettleOrder {
  const kindOf = new Map<string, string>();
  const order: string[] = [];
  for (const { event } of journal.listEvents(runId)) {
    if (event.type === "node-queued") {
      kindOf.set(refToString(event.instance), event.kind);
    } else if (event.type === "node-settled") {
      const key = refToString(event.instance);
      if (kindOf.get(key) !== "report") order.push(key);
    }
  }
  return new ReplaySettleOrder(order);
}
