/* FreeCodeZ fork 惰性空壳(P2):登录链已删。运行时行为等同删除,物理移除留待品牌清扫批次。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function useOAuth(): any {
  return { user: null, isLoading: false, error: null, login: async () => {}, logout: async () => {} };
}
