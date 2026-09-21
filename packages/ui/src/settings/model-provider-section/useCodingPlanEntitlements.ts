/* FreeCodeZ fork 惰性空壳(P2):运行时行为等同删除,物理移除留待品牌清扫批次。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function useCodingPlanEntitlements(..._a: unknown[]): any {
  return { entitlement: null, loading: false, refresh: async () => {}, error: null };
}
export function useCodingPlanAccessRefresh(..._a: unknown[]): { refresh: () => void } {
  return { refresh: () => {} };
}
