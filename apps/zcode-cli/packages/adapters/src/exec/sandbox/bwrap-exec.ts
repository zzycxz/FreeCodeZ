// E-S4：Linux 侧沙箱包装（bubblewrap/bwrap，与 macOS sandbox-exec 同型的命令包装器）。
// 策略与 seatbelt 版一致（workspace-write）：全盘只读 + workspace/可写根/tmp 可写 +
// 网络允许（bwrap 默认共享网络，不额外断）。--dev /dev 提供 /dev/null（git 重定向
// 需要）；--proc /proc 供 node/ps 等；进程组不被 unshare，宿主的进程树终止链照旧。
// 只用上古稳定 flag（--ro-bind/--bind/--dev/--proc/--tmpfs），不用 --die-with-parent
// 等较新旗标——未知旗标会让 bwrap 整体报错，违反"正常命令零新增失败"红线。
import { existsSync } from "node:fs";
import type { ExecutionSandboxPolicy } from "@zcode/contracts";
import type { ResolvedSpawnCommand } from "../execution-command.js";
import type { SandboxWrapResult } from "./wrap.js";

export const BWRAP_CANDIDATE_PATHS = [
  "/usr/bin/bwrap",
  "/usr/local/bin/bwrap",
  "/bin/bwrap",
] as const;

export function findBwrapPath(): string | undefined {
  for (const candidate of BWRAP_CANDIDATE_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export interface WorkspaceWriteBwrapInput {
  workspaceRoot: string;
  writableRoots?: readonly string[];
  /** 缺省 /tmp；与 /tmp 相同则由 tmpfs 覆盖，无需单独 bind。 */
  tmpDir?: string;
}

/** 生成 workspace-write 的 bwrap 参数（纯函数；bind 源必须真实存在，由包装器保证）。 */
export function buildWorkspaceWriteBwrapArgs(input: WorkspaceWriteBwrapInput): string[] {
  const bindWritable: string[] = [];
  const pushBind = (rawPath: string | undefined) => {
    const path = rawPath?.trim();
    if (!path || path === "/tmp") return; // /tmp 由 tmpfs 覆盖
    if (bindWritable.includes(path)) return;
    if (!existsSync(path)) return; // bind 不存在的源会让 bwrap 报错，宁可不 bind
    bindWritable.push(path);
  };
  pushBind(input.workspaceRoot);
  for (const root of input.writableRoots ?? []) pushBind(root);
  pushBind(input.tmpDir ?? defaultTmpDir());

  return [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    ...bindWritable.flatMap((path) => ["--bind", path, path]),
  ];
}

function defaultTmpDir(): string {
  return typeof process !== "undefined" && typeof process.env?.TMPDIR === "string"
    ? process.env.TMPDIR
    : "/tmp";
}

export function wrapCommandWithBwrap(input: {
  policy: ExecutionSandboxPolicy | undefined;
  command: ResolvedSpawnCommand;
}): SandboxWrapResult {
  const policy = input.policy;
  // 激活语义与 seatbelt 一致：必须显式 mode（enabled 是历史遥测位，见 wrap.ts 注释）。
  if (
    !policy ||
    policy.mode !== "workspace-write" ||
    policy.enabled === false ||
    policy.dangerouslyDisableSandbox === true
  ) {
    return { command: input.command, sandboxed: false, skippedReason: "disabled" };
  }
  const bwrap = findBwrapPath();
  if (!bwrap) {
    // bwrap 未安装：fail-open（原样执行）——绝不让正常命令因沙箱不可用而失败；
    // skippedReason 可观测，调用方留痕。
    return { command: input.command, sandboxed: false, skippedReason: "sandbox-exec-missing" };
  }
  if (!policy.workspaceRoot || !existsSync(policy.workspaceRoot)) {
    return { command: input.command, sandboxed: false, skippedReason: "no-workspace-root" };
  }

  const sandboxArgs = buildWorkspaceWriteBwrapArgs({
    workspaceRoot: policy.workspaceRoot,
    writableRoots: policy.writableRoots,
  });

  if (input.command.shell === false) {
    return {
      sandboxed: true,
      command: {
        ...input.command,
        file: bwrap,
        args: [...sandboxArgs, "--", input.command.file, ...input.command.args],
        shell: false,
      },
    };
  }

  const shellPath = typeof input.command.shell === "string" ? input.command.shell : "/bin/bash";
  // 必须补 -c（与 seatbelt-exec 同因）：node spawn 的 shell 语义是 `shell -c <命令文本>`，
  // 缺 -c 时 bash 会把命令文本当脚本文件名执行，命令必败，违反零新增失败红线。
  return {
    sandboxed: true,
    command: {
      ...input.command,
      file: bwrap,
      args: [...sandboxArgs, "--", shellPath, "-c", input.command.file],
      shell: false,
    },
  };
}
