/* FreeCodeZ fork 惰性空壳(P2):运行时行为等同删除,物理移除留待品牌清扫批次。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* FreeCodeZ fork 兼容壳(P2):闲时链已删;仅保留 UI 仍引用的最小类型与恒假判定。 */
export interface ZCodeOffPeakTask {
  [key: string]: any;
}
export function isOffPeakTicketExpiredError(_error: unknown): boolean {
  return false;
}
