// E-S4：沙箱包装平台分发器。激活语义的**唯一权威定义**在这里：
//   policy.mode === "workspace-write" && enabled !== false && 未显式逃生
// ——注意 `enabled` 是历史遥测位（Bash handler 对普通命令恒 true），绝不能作为激活
// 条件（曾因此险些让 mac 默认全量沙箱化，回归锚测试见 sandboxSeatbelt.test）。
// 平台矩阵：darwin=seatbelt（sandbox-exec 系统自带）；linux=bwrap（未安装则
// fail-open + 可观测原因）；win32=低完整级 MIC（windows-il-exec，见该文件头注；
// 集成验证通过前 UI 保持禁用）；其余平台=unsupported-platform。
import type { ExecutionSandboxPolicy } from "@zcode/contracts";
import type { ResolvedSpawnCommand } from "../execution-command.js";
import { wrapCommandWithSeatbelt } from "./seatbelt-exec.js";
import { wrapCommandWithBwrap } from "./bwrap-exec.js";
import { wrapCommandWithWindowsLowIL } from "./windows-il-exec.js";

export interface SandboxWrapResult {
  command: ResolvedSpawnCommand;
  sandboxed: boolean;
  /** 未激活/无法满足的原因（日志与遥测用；"disabled"=未启用属正常路径）。 */
  skippedReason?:
    | "disabled"
    | "non-darwin"
    | "sandbox-exec-missing"
    | "no-workspace-root"
    | "unsupported-platform";
}

export function wrapCommandWithSandbox(input: {
  policy: ExecutionSandboxPolicy | undefined;
  platform: NodeJS.Platform;
  command: ResolvedSpawnCommand;
}): SandboxWrapResult {
  // 快速路径：未启用/显式逃生时连平台判定都跳过（与现状逐字一致）。
  const policy = input.policy;
  if (
    !policy ||
    policy.mode !== "workspace-write" ||
    policy.enabled === false ||
    policy.dangerouslyDisableSandbox === true
  ) {
    return { command: input.command, sandboxed: false, skippedReason: "disabled" };
  }
  if (input.platform === "darwin") {
    return wrapCommandWithSeatbelt(input);
  }
  if (input.platform === "linux") {
    return wrapCommandWithBwrap(input);
  }
  if (input.platform === "win32") {
    return wrapCommandWithWindowsLowIL(input);
  }
  return { command: input.command, sandboxed: false, skippedReason: "unsupported-platform" };
}
