// R21c（2026-10-09 用户裁决「TCC 条目由应用自身产生，不走手动 +/拖拽」）：helper 一次性
// 权限请求模式实现体（helper-main --request-permissions 的承载，独立模块亦守 helper-main
// 的 max-lines 预算）。helper 以自身身份请求 AX + 录屏（各建一行 TCC 条目），无需 --socket。
// 请求当刻条目即创建；驻留至多 30s 让系统弹窗绑定存活进程（双授即退，超时照退）。
import {
  probePermissions,
  requestAccessibilityAccess,
  requestScreenCaptureAccess,
} from "./ax-observation.js";

export const PERMISSION_REQUEST_MODE_MAX_WAIT_MS = 30_000;
export const PERMISSION_REQUEST_MODE_POLL_MS = 500;
export const PERMISSION_REQUEST_MODE_MAX_ATTEMPTS = 60;

export async function runPermissionRequestMode({
  diagnostic = (text) => process.stderr.write(text),
  exit = (code) => process.exit(code),
  now = () => Date.now(),
  permissionRequests,
} = {}) {
  const requestAccessibility =
    permissionRequests?.requestAccessibilityAccess ?? requestAccessibilityAccess;
  const requestScreen =
    permissionRequests?.requestScreenCaptureAccess ?? requestScreenCaptureAccess;
  const probe = permissionRequests?.probePermissions ?? probePermissions;
  const sleep =
    permissionRequests?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const accessibility = requestAccessibility();
  const screenCapture = requestScreen();
  diagnostic(`${JSON.stringify({ mode: "request-permissions", accessibility, screenCapture })}\n`);
  const deadline = now() + PERMISSION_REQUEST_MODE_MAX_WAIT_MS;
  for (let attempt = 0; attempt < PERMISSION_REQUEST_MODE_MAX_ATTEMPTS && now() < deadline; attempt += 1) {
    const status = probe();
    if (status.accessibility && status.screenCapture) break;
    await sleep(PERMISSION_REQUEST_MODE_POLL_MS);
  }
  exit(0);
}
