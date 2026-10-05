// Phase 1 macOS koffi 执行层的公开出口（broker 方法表工厂 + 探针）。
export { createKoffiBrokerMethods } from "./koffi-broker-methods.js";
export { loadKoffiBindings } from "./koffi-ax.js";
export { probePermissions as probePermissionsInProcess } from "./ax-observation.js";
export {
  cursorEventsForClick,
  cursorEventsForDrag,
  cursorEventsForKey,
  cursorEventsForText,
  emitCursorEvents,
  CURSOR_EVENT_WIRE_VERSION,
  CURSOR_HOTSPOT,
} from "./cursor-events.js";
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
export {
  primarySpringResponse,
  cursorMotionStep,
  isCloseEnough,
  bezierPathCandidates,
  scootTransform,
  clickTransform,
  clamp,
  PRIMARY_SPRING_DAMPING,
  SCOOT_THRESHOLD_PT,
  SCOOT_RESPONSE,
  SCOOT_DAMPING,
  SCOOT_STRETCH,
  SCOOT_MAX_ROTATION_DEG,
  CLICK_ANGLE_DEG,
  BEZIER_PARAMS,
  STRAIGHT_LINE_THRESHOLD_PT,
  CLOSE_ENOUGH_PT,
  STRETCH_PIVOT_X,
} from "./cursor-animation.js";
