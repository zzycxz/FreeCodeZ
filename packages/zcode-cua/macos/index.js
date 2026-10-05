// Phase 1 macOS koffi 执行层的公开出口（broker 方法表工厂 + 探针）。
export { createKoffiBrokerMethods } from "./koffi-broker-methods.js";
export { loadKoffiBindings } from "./koffi-ax.js";
export { probePermissions as probePermissionsInProcess } from "./ax-observation.js";
