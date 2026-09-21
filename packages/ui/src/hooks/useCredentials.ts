/* FreeCodeZ fork 惰性空壳(P2):运行时行为等同删除,物理移除留待品牌清扫批次。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function useCredentials(..._a: unknown[]): any {
  return { credentials: [] as never[] };
}
export function useAuthToken(..._a: unknown[]): any {
  return { token: null, tryRefresh: async () => null, clearCredentials: () => {} };
}
