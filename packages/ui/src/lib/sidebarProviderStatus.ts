/**
 * 侧栏底栏 key 健康三态的纯映射（docs/spec/sidebar-provider-key-status.md）。
 * 只消费 registry 事实，不读取、不校验 key 字符串，也不发起二次请求猜状态。
 */

export type SidebarProviderKeyHealth = "not-configured" | "ready" | "invalid";

/** 展示层需要的最小 registry 事实；hasPersonalConfig 是"是否保存过个人配置"，不是 key 内容。 */
export interface SidebarProviderKeyHealthFacts {
  readonly enabled?: boolean;
  readonly executable?: boolean;
  readonly hasPersonalConfig?: boolean;
}

export function resolveSidebarProviderKeyHealth(
  provider: SidebarProviderKeyHealthFacts | null | undefined,
): SidebarProviderKeyHealth {
  if (!provider) {
    return "not-configured";
  }
  // 停用视为不可用，归入"失效"档；tooltip 文案覆盖"失效或配置有误"。
  if (provider.enabled === false) {
    return "invalid";
  }
  if (provider.executable) {
    return "ready";
  }
  return provider.hasPersonalConfig ? "invalid" : "not-configured";
}
