/* FreeCodeZ fork 惰性空壳(P2):该 UI 已随账号/闲时链下线;运行时行为等同删除,物理移除留待品牌清扫批次。 */
export type OffPeakCreateBlockReason = "plan" | "quota" | "unavailable" | null;
export const OFF_PEAK_CREATE_TOOLTIP_CLASSNAME = "";
export function formatOffPeakRemainingWait(_n: number, _now: number, _i: unknown): string {
  return "";
}
export function resolveOffPeakCreateBlockReason(_i: unknown): OffPeakCreateBlockReason {
  return null;
}
