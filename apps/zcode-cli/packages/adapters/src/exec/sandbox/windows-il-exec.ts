// E-S4(W)：Windows 沙箱——低完整性级别（Mandatory Integrity Check，内核强制）。
// 原理：进程降到 Low IL 后，内核 MIC 禁止写任何更高 IL 的对象（用户文件默认
// Medium IL → 全目录写保护，读不受限=保持"全盘读"策略）；把 workspace 递归标为
// Low IL（icacls /setintegritylevel，普通用户权限即可降标、Medium 进程仍可写它、
// 无需恢复清理）即得到"全盘读 + 仅 workspace 可写"。网络在 Low IL 下的行为取决于
// Windows 防火墙默认策略——集成测试（win32 自动激活）含出网用例，验证后才能放开
// UI（本文件实现即绪，UI 门控见 AutomationEditView）。
// 为何不用 codex 的 AppContainer+Windows 服务：那需要原生 Rust 辅助与服务安装
// （提权/UAC，违反"安全不添麻烦"红线）；MIC 方案零原生依赖、纯 spawn 可达，
// 强度上对"全盘读+workspace 写"这一策略形状等价（AppContainer 额外能限读，非本策略所需）。
import type { ExecutionSandboxPolicy } from "@zcode/contracts";
import type { ResolvedSpawnCommand } from "../execution-command.js";
import type { SandboxWrapResult } from "./wrap.js";

export const POWERSHELL_CANDIDATES = [
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "powershell.exe",
] as const;

export function findPowerShellPath(): string | undefined {
  return POWERSHELL_CANDIDATES[0];
}

/** PowerShell 单引号转义（' → ''）。 */
function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * 生成降 IL 的 PowerShell 脚本（纯函数）：Add-Type 编译一段 C# 调
 * SetTokenInformation(TokenIntegrityLevel, Low) 于**自身进程**（Medium→Low 允许、
 * 无需特权），随后执行目标命令——子进程继承已降低的主令牌；exit $LASTEXITCODE
 * 透传退出码。命令行经 argv 逐项单引号包裹，不经过二次 shell 解释。
 */
export function buildLowIntegrityScript(input: { commandLine: string }): string {
  return [
    // --% 不适用；-Command 内此处用分号串联，脚本由 -EncodedCommand 或 -Command 传入。
    "$ErrorActionPreference='Stop'",
    LOW_IL_CSHARP_SETUP,
    "[LowIntegrity]::DropToLow()",
    `& ${input.commandLine}`,
    "if ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE }",
  ].join("\n");
}

/** 降 IL 的 C# 片段（SECURITY_MANDATORY_LABEL_AUTHORITY=0x10, Low RID=0x1000, class=25）。 */
export const LOW_IL_CSHARP_SETUP = String.raw`
$src = @'
using System;
using System.Runtime.InteropServices;
public static class LowIntegrity {
  [StructLayout(LayoutKind.Sequential)]
  struct SID_IDENTIFIER_AUTHORITY { public byte b0,b1,b2,b3,b4,b5; }
  [StructLayout(LayoutKind.Sequential)]
  struct TOKEN_MANDATORY_LABEL { public IntPtr Label; }
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool AllocateAndInitializeSid(ref SID_IDENTIFIER_AUTHORITY auth, byte count, int r0, int r1, int r2, int r3, int r4, int r5, int r6, int r7, out IntPtr sid);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool SetTokenInformation(IntPtr token, int infoClass, ref TOKEN_MANDATORY_LABEL info, int infoLength);
  public static void DropToLow() {
    SID_IDENTIFIER_AUTHORITY auth = default(SID_IDENTIFIER_AUTHORITY);
    auth.b5 = 16; // SECURITY_MANDATORY_LABEL_AUTHORITY
    IntPtr sid;
    if (!AllocateAndInitializeSid(ref auth, 1, 0x1000, 0,0,0,0,0,0,0, out sid))
      throw new Exception("AllocateAndInitializeSid failed: " + Marshal.GetLastWin32Error());
    TOKEN_MANDATORY_LABEL label = new TOKEN_MANDATORY_LABEL();
    label.Label = sid;
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x0008 /*TOKEN_ADJUST_DEFAULT*/, out token))
      throw new Exception("OpenProcessToken failed: " + Marshal.GetLastWin32Error());
    if (!SetTokenInformation(token, 25 /*TokenIntegrityLevel*/, ref label, Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL)) + IntPtr.Size))
      throw new Exception("SetTokenInformation failed: " + Marshal.GetLastWin32Error());
  }
}
'@
Add-Type -TypeDefinition $src
`.trim();

/**
 * 生成 icacls 降标参数（workspace → Low IL，可继承）：Medium 进程写它=向下写仍允许
 * （不影响正常工作流），Low IL 进程写它=同级允许——无需任何恢复清理。
 */
export function buildWorkspaceLabelArgs(workspaceRoot: string): string[] {
  return [workspaceRoot, "/setintegritylevel", "(OI)(CI)L"];
}

export function wrapCommandWithWindowsLowIL(input: {
  policy: ExecutionSandboxPolicy | undefined;
  command: ResolvedSpawnCommand;
  /** 注入便于测试；缺省探测 System32 PowerShell。 */
  powershellPath?: string;
}): SandboxWrapResult {
  const policy = input.policy;
  if (
    !policy ||
    policy.mode !== "workspace-write" ||
    policy.enabled === false ||
    policy.dangerouslyDisableSandbox === true
  ) {
    return { command: input.command, sandboxed: false, skippedReason: "disabled" };
  }
  const powershell = input.powershellPath ?? findPowerShellPath();
  if (!powershell) {
    return { command: input.command, sandboxed: false, skippedReason: "sandbox-exec-missing" };
  }
  if (!policy.workspaceRoot) {
    return { command: input.command, sandboxed: false, skippedReason: "no-workspace-root" };
  }

  // 目标命令行组装：argv 模式逐项单引号包裹；shell 模式（file=命令文本）交给
  // cmd /d /s /c 执行（与 node spawn 的 shell 语义一致）。
  const target =
    input.command.shell === false
      ? [input.command.file, ...input.command.args].map(psQuote).join(" ")
      : `& ${psQuote(process.env.ComSpec ?? "cmd.exe")} /d /s /c ${psQuote(input.command.file)}`;

  const script = buildLowIntegrityScript({ commandLine: target });
  return {
    sandboxed: true,
    command: {
      ...input.command,
      file: powershell,
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      shell: false,
    },
    // workspace 降标指令由调用方（prepareChildSpawn）在 spawn 前执行；这里随结果
    // 透出，保持包装器本身纯同步、可测。
    labelArgs: buildWorkspaceLabelArgs(policy.workspaceRoot),
  } as SandboxWrapResult & { labelArgs: string[] };
}
