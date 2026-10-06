export interface E2ETestBridgeEnvironment {
  // 条目 1 键名联动收口：新键优先，旧键 ZCODE_* 回退（E2E runner 外部脚本可继续用旧键）。
  VITE_FREECODEZ_E2E_STORE_BRIDGE?: string;
  VITE_ZCODE_E2E_STORE_BRIDGE?: string;
  FREECODEZ_E2E_RUN_ID?: string;
  ZCODE_E2E_RUN_ID?: string;
}

/**
 * Main/preload 的 E2E 能力必须同时命中专用 build flag 和真实 runner run id。
 * ZCODE_ENV=test 只是产品环境，不能据此扩大 renderer 可读面。
 */
export function shouldEnableE2ETestBridge(env: E2ETestBridgeEnvironment): boolean {
  const bridgeFlag = env.VITE_FREECODEZ_E2E_STORE_BRIDGE?.trim() || env.VITE_ZCODE_E2E_STORE_BRIDGE;
  const runId = env.FREECODEZ_E2E_RUN_ID?.trim() || env.ZCODE_E2E_RUN_ID?.trim();
  return bridgeFlag === "1" && Boolean(runId);
}
