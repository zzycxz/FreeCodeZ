import { setUserActionTelemetry } from "@zcode/ui";

/**
 * FreeCodeZ fork:渲染动作 trace 的 main 侧 IPC(rendererActionTraceIpc)与 OTel 导出链
 * 已物理删除(2026-09-22,随 ARMS 遥测簇拆除)。埋点调用面(runUserAction 等)保留为
 * no-op,避免几十处 UI 调用点的大范围手术;后续品牌清扫批次再统一清除调用点。
 */
export function initializeDesktopUserActionTrace(_options: {
  platform: unknown;
  isLocalDevelopmentRuntime: boolean;
}): () => void {
  setUserActionTelemetry(null);
  return () => {};
}
