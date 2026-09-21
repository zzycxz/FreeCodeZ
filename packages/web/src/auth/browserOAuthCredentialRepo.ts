/* FreeCodeZ fork 惰性空壳(P2 §4.7):Web OAuth 登录已删;物理移除留待品牌清扫批次。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type WebOAuthProviderId = string;

export class BrowserOAuthCredentialRepo {
  async load(_k: string): Promise<null> {
    return null;
  }
  async store(_k: string, _v: unknown): Promise<void> {}
  async remove(_k: string): Promise<void> {}
}
