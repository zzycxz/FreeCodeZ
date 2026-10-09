// FreeCodeZ 修剪 barrel（W-29）：appshot/热键/权限探测链出口（执行层不入）。
export { loadKoffiBindings } from "./koffi-ax.js";
export {
  probePermissions as probePermissionsInProcess,
  requestScreenCaptureAccess as requestScreenCaptureAccessInProcess,
  requestAccessibilityAccess as requestAccessibilityAccessInProcess,
} from "./ax-observation.js";
export {
  appshotSnapshot,
  captureWindowPng,
  pickFrontmostAppWindow,
  buildOnScreenWindowsReader,
  FRONTMOST_MIN_WINDOW_SIZE,
} from "./appshot.js";
export {
  createModifierDoubleTapWatcher,
  nextDoubleTapState,
  MODIFIER_KEY_CODES,
  DOUBLE_TAP_WINDOW_MS,
} from "./hotkey-tap.js";
