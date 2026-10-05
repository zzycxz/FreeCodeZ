export { resolveEffectiveBashShellSelection } from "./bash-shell-provider.js";
export {
  applyResolvedShellCommandForTest,
  buildExecutionEnv,
  resolveExecutionCommand,
  setResolvedShellLoginMode,
} from "./execution-command.js";
export type { ResolvedSpawnCommand } from "./execution-command.js";
export type { NodeExecutionAdapterOptions } from "./execution-adapter-types.js";
export { createNodeExecutionAdapter, NodeExecutionAdapter } from "./node-execution-adapter.js";
export { decodeExecutionOutputBuffer } from "./outputEncoding.js";
// 条目 6 doctor 环境探针消费（沙箱执行体在场性探测）；实现仍在 sandbox/seatbelt-exec.ts。
export { SANDBOX_EXEC_PATH } from "./sandbox/seatbelt-exec.js";
