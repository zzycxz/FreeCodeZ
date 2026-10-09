// R21b 主应用录屏条目自注册（computer-control-capability.md R21 增补，2026-10-09
// 用户裁决「FreeCodeZ 要像 ZCode 一样主动要求权限」）：
// Appshot 喂屏与电脑控制观测的截屏主体都是主应用；macOS「屏幕录制」列表只在
// CGRequestScreenCaptureAccess 或拖入时产生条目，触发点藏在功能深处时用户遇不到
// （2026-10-09 两轮装机实测列表均落空）。故启动期一次性自注册：权限状态已定时该调用
// 零弹窗 no-op（已授直接返回、已拒不再弹），只在装机后未定态弹一次。失败不抛、不阻断调用方。
import {
  probePermissionsInProcess,
  requestScreenCaptureAccessInProcess,
} from "./cua-runtime/index.js";

export interface ScreenRecordingRegistrationDeps {
  probeScreenCapture?: () => boolean;
  requestScreenCaptureAccess?: () => { granted?: boolean } | undefined;
  log?: (message: string, context?: Record<string, unknown>) => void;
}

/** 未授权则发起一次自注册请求；返回是否发起了请求（已授权/失败均返回 false）。 */
export function ensureMainScreenRecordingRegistration(
  deps: ScreenRecordingRegistrationDeps = {},
): boolean {
  const probe = deps.probeScreenCapture ?? (() => probePermissionsInProcess().screenCapture);
  const request =
    deps.requestScreenCaptureAccess ?? (() => requestScreenCaptureAccessInProcess());
  try {
    if (probe()) return false;
    const result = request();
    deps.log?.("Main app screen recording self-registration attempted", {
      event: "cua.screen_capture_request",
      granted: result?.granted ?? false,
    });
    return true;
  } catch (error) {
    deps.log?.("Main app screen recording self-registration failed", {
      event: "cua.screen_capture_request_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
