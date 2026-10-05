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
