/* FreeCodeZ fork 惰性空壳(P2):运行时行为等同删除,物理移除留待品牌清扫批次。
   修复:消费方(ModelProviderSection/V4ComposerToolbar)解构
   entitlements/enabledStartPlanProviderIds 并在 render 期直接 entitlements[providerId];
   空壳此前缺这两个字段(undefined),进入设置/模型分区即抛
   "Cannot read properties of undefined (reading 'account:bigmodel-start-plan')"。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function useCodingPlanEntitlements(..._a: unknown[]): any {
  return {
    entitlement: null,
    entitlements: {},
    enabledStartPlanProviderIds: [],
    loading: false,
    refresh: async () => {},
    error: null,
  };
}
export function useCodingPlanAccessRefresh(..._a: unknown[]): { refresh: () => void } {
  return { refresh: () => {} };
}
