type E2EStoreBridgeImportMetaEnv = {
  // 条目 1 键名联动：新键优先，旧键经 vite define 双定义兼容（见 desktop/vite.config.ts）。
  VITE_FREECODEZ_E2E_STORE_BRIDGE?: string;
  VITE_ZCODE_E2E_STORE_BRIDGE?: string;
};

function readE2EStoreBridgeImportMetaEnv(): E2EStoreBridgeImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: E2EStoreBridgeImportMetaEnv }).env ??
    {}) as E2EStoreBridgeImportMetaEnv;
}

export function shouldExposeE2EStoreBridge(
  env: E2EStoreBridgeImportMetaEnv = readE2EStoreBridgeImportMetaEnv(),
): boolean {
  const flag = env.VITE_FREECODEZ_E2E_STORE_BRIDGE?.trim() || env.VITE_ZCODE_E2E_STORE_BRIDGE;
  return typeof window !== "undefined" && flag === "1";
}
