// FreeCodeZ fork(P2 §4.9):登录链遗留键的一次性启动清理。复用 CLI 侧共享凭据仓库
// (加密读写);仅暴露本模块需要的三个操作,避免把完整仓库面泄漏进 services。
import { createSharedZCodeCredentialStore } from "@zcode/adapters";

export interface LegacyCleanupCredentialStore {
  loadMany(keys: readonly string[]): Promise<Record<string, string | null>>;
  delete(key: string): Promise<void>;
}

export function createLegacyCleanupCredentialStore(
  env: NodeJS.ProcessEnv,
): LegacyCleanupCredentialStore {
  const store = createSharedZCodeCredentialStore({ env });
  return {
    loadMany: (keys) => store.loadMany(keys),
    delete: (key) => store.delete(key),
  };
}
