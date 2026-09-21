/* FreeCodeZ fork 惰性空壳(P2):运行时行为等同删除,物理移除留待品牌清扫批次。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function CodingPlanEntryButton(props: any): null {
  void props;
  return null;
}
export function useCodingPlanEntryGate(..._a: unknown[]): any {
  return { status: "hidden", label: null, retry: () => {} };
}
export function useCodingPlanEntryPlanList(..._a: unknown[]): any {
  return { plans: [] as never[], loading: false, snapshot: null, refresh: async () => {} };
}
