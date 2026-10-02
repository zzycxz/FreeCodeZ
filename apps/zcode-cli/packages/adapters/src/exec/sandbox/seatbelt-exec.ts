// E-S1：spawn 侧的 seatbelt 包装（macOS only）。把已解析的 spawn 命令变换为
// `/usr/bin/sandbox-exec -p <profile> -- <原命令>`，让既有执行链（输出采集、cwd
// 捕获、进程树终止、后台任务）全部照旧。默认 off：policy 未启用/平台不符/二进制
// 缺失时原样返回（fail-open + warn 由调用方记录——正常命令零新增失败是红线，
// 沙箱二进制缺失时宁可退回现状也不让所有命令失败）。
import { existsSync } from "node:fs";
import type { ExecutionSandboxPolicy } from "@zcode/contracts";
import { buildWorkspaceWriteSeatbeltProfile } from "./seatbelt-profile.js";
import type { ResolvedSpawnCommand } from "../execution-command.js";
import type { SandboxWrapResult } from "./wrap.js";

export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

export interface SeatbeltWrapInput {
  policy: ExecutionSandboxPolicy | undefined;
  platform: NodeJS.Platform;
  /** 已解析的原始 spawn 命令。 */
  command: ResolvedSpawnCommand;
}

export type SeatbeltWrapResult = SandboxWrapResult;

export function wrapCommandWithSeatbelt(input: SeatbeltWrapInput): SeatbeltWrapResult {
  const policy = input.policy;
  // 激活条件是**显式 mode**，不是 enabled：Bash handler 对每条普通命令都置
  // enabled:true（历史遥测语义），若以 enabled 激活，mac 上会默认全量沙箱化，
  // 违反"默认 off"红线。只有上层显式声明 workspace-write 才包装。
  if (
    !policy ||
    policy.mode !== "workspace-write" ||
    policy.enabled === false ||
    policy.dangerouslyDisableSandbox === true
  ) {
    return { command: input.command, sandboxed: false, skippedReason: "disabled" };
  }
  if (input.platform !== "darwin") {
    // 首期仅 macOS；Linux/Windows 维持 off 并明示（规格书 R5）。
    return { command: input.command, sandboxed: false, skippedReason: "non-darwin" };
  }
  if (!existsSync(SANDBOX_EXEC_PATH)) {
    return { command: input.command, sandboxed: false, skippedReason: "sandbox-exec-missing" };
  }
  const profile =
    policy.profile ??
    (policy.workspaceRoot
      ? buildWorkspaceWriteSeatbeltProfile({
          workspaceRoot: policy.workspaceRoot,
          writableRoots: policy.writableRoots,
        })
      : undefined);
  if (!profile) {
    return { command: input.command, sandboxed: false, skippedReason: "no-workspace-root" };
  }

  // shell 模式（file=命令文本, shell=true|shell 路径）与 argv 模式统一抬进
  // sandbox-exec 的 argv 里；包装后不再走 node 的 shell 解释。
  if (input.command.shell === false) {
    return {
      sandboxed: true,
      command: {
        ...input.command,
        envOverlay: input.command.envOverlay,
        file: SANDBOX_EXEC_PATH,
        args: ["-p", profile, "--", input.command.file, ...input.command.args],
        shell: false,
      },
    };
  }

  const shellPath =
    typeof input.command.shell === "string" ? input.command.shell : "/bin/bash";
  return {
    sandboxed: true,
    command: {
      ...input.command,
      file: SANDBOX_EXEC_PATH,
      args: ["-p", profile, "--", shellPath, input.command.file],
      shell: false,
    },
  };
}
