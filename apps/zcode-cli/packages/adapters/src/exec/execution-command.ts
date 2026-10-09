import { existsSync } from "node:fs";
import { extname } from "node:path";
import {
  sanitizeZCodeRuntimeEnvInPlace,
} from "@zcode/shared/runtime-env";
import { applyNetworkEgressEnv, type NetworkEgressEnvPolicy } from "../network/subprocess-env.js";
import {
  resolveEffectiveBashShellSelection,
  type BashShellProvider,
} from "./bash-shell-provider.js";
import { applyExecutionTextEnv } from "./outputEncoding.js";
import { windowsExecutableCandidates } from "./windows-executable.js";
import type {
  ExecutionCommand,
  ExecutionEnvOverlay,
  ExecutionShellDialect,
} from "@zcode/contracts";

const WINDOWS_COMMAND_SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);

// B2 输出卫生：用户 shell 配置常带 color alias（如 alias ls='ls --color=always'），
// ANSI 转义对模型是纯冗余编码——E3 实测 git diff +27%、grep +30% token 膨胀，重 diff
// 会话损耗 15-59% 压缩阈值。注入无色化/分页禁用变量（git 工具侧 services/git/config.ts
// 已有同款先例），并提供 ZCODE_PRESERVE_COLOR=1 逃生口（如需彩色 artifact）。
const OUTPUT_HYGIENE_ENV_SET: Readonly<Record<string, string>> = {
  NO_COLOR: "1",
  TERM: "dumb",
  COLORTERM: "",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GH_PAGER: "cat",
};
// 这些变量会越过 NO_COLOR 强制开色，需一并摘除。
const OUTPUT_HYGIENE_ENV_UNSET: readonly string[] = ["FORCE_COLOR", "CLICOLOR_FORCE"];
const PRESERVE_COLOR_ENV_KEY = "FREECODEZ_PRESERVE_COLOR";
const PRESERVE_COLOR_LEGACY_ENV_KEY = "ZCODE_PRESERVE_COLOR";

function isPreserveColorRequested(sourceEnv: NodeJS.ProcessEnv): boolean {
  const value = sourceEnv[PRESERVE_COLOR_ENV_KEY] ?? sourceEnv[PRESERVE_COLOR_LEGACY_ENV_KEY];
  return value === "1" || value === "true";
}

function applyOutputHygieneEnv(
  env: Record<string, string>,
  platform: NodeJS.Platform,
  options: { preserveColor: boolean },
): void {
  if (options.preserveColor) return;
  for (const key of OUTPUT_HYGIENE_ENV_UNSET) {
    deleteEnvKey(env, key, platform);
  }
  for (const [key, value] of Object.entries(OUTPUT_HYGIENE_ENV_SET)) {
    setEnvKey(env, key, value, platform);
  }
}

export interface ResolvedSpawnCommand {
  args: string[];
  cwdDialect: ExecutionShellDialect;
  envOverlay?: Record<string, string>;
  file: string;
  shell: boolean | string;
  usesLoginShell?: boolean;
}

export function buildExecutionEnv(
  overlay?: ExecutionEnvOverlay,
  options: {
    network?: NetworkEgressEnvPolicy;
    platform?: NodeJS.Platform;
    processEnv?: NodeJS.ProcessEnv;
  } = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const sourceEnv = options.processEnv ?? process.env;
  const env: Record<string, string> = {};

  if (overlay?.base !== "empty") {
    for (const [key, value] of Object.entries(sourceEnv)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    // Bash/tool 子进程不能直接继承运行时的 NODE_ENV、http_proxy 或证书变量。
    // 网络变量会在 applyNetworkEgressEnv 中从 ZCode 内部封存恢复，避免 app/provider 运行时先被污染。
    sanitizeZCodeRuntimeEnvInPlace(env);
  }

  applyExecutionTextEnv(env, platform);

  applyOutputHygieneEnv(env, platform, {
    preserveColor: isPreserveColorRequested(sourceEnv),
  });

  applyNetworkEgressEnv(env, {
    network: options.network,
    platform,
    sourceEnv,
    toolEnvPassthrough: overlay?.base !== "empty",
  });

  for (const key of overlay?.unset ?? []) {
    deleteEnvKey(env, key, platform);
  }

  for (const [key, value] of Object.entries(overlay?.set ?? {})) {
    setEnvKey(env, key, value, platform);
  }

  return env;
}

export function resolveExecutionCommand(
  command: ExecutionCommand,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
    platform?: NodeJS.Platform;
    resolvedShell?: ResolvedSpawnCommand;
  } = {},
): ResolvedSpawnCommand {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (command.mode === "shell") {
    if (options.resolvedShell) {
      return applyResolvedShellCommand(options.resolvedShell, command.command);
    }

    if (command.shellProfile === "posix-bash") {
      const resolution = resolveEffectiveBashShellSelection({
        env,
        exists: options.exists,
        override: command.shellOverride,
        platform,
      });
      if (resolution.provider) {
        return createShellProviderCommand(resolution.provider, command.command);
      }
    }

    return {
      args: [],
      cwdDialect: defaultCwdDialect(platform),
      file: command.command,
      shell: resolveShell(command.shell, env, platform),
    };
  }

  if (platform !== "win32") {
    return {
      args: command.args ?? [],
      cwdDialect: "posix",
      file: command.file,
      shell: false,
    };
  }

  const resolvedFile = resolveWindowsExecutable(command.file, {
    cwd: options.cwd,
    env,
    exists: options.exists,
  });
  if (!isWindowsCommandShim(resolvedFile)) {
    return {
      args: command.args ?? [],
      cwdDialect: "cmd",
      file: resolvedFile,
      shell: false,
    };
  }

  // Note: Windows .cmd/.bat shims cannot be spawned directly with shell:false.
  // Route them through cmd.exe while keeping normal .exe argv execution shell-free.
  return {
    args: createCmdShimArgs(resolvedFile, command.args ?? []),
    cwdDialect: "cmd",
    file: getEnvValue(env, "ComSpec", "win32") ?? "cmd.exe",
    shell: false,
  };
}

function createShellProviderCommand(
  provider: BashShellProvider,
  command: string,
): ResolvedSpawnCommand {
  if (provider.dialect === "cmd") {
    return {
      args: [],
      cwdDialect: provider.dialect,
      envOverlay: provider.envOverlay,
      file: command,
      shell: provider.shell,
    };
  }

  return {
    args: ["-c", "-l", command],
    cwdDialect: provider.dialect,
    envOverlay: provider.envOverlay,
    file: provider.file,
    shell: provider.shell,
    usesLoginShell: true,
  };
}

export function setResolvedShellLoginMode(
  resolved: ResolvedSpawnCommand,
  useLoginShell: boolean,
): ResolvedSpawnCommand {
  if (resolved.shell !== false || resolved.args[0] !== "-c") return resolved;
  if (resolved.usesLoginShell !== true) return resolved;

  const command = resolved.args.at(-1) ?? "";
  return {
    ...resolved,
    args: useLoginShell ? ["-c", "-l", command] : ["-c", command],
  };
}

export function applyResolvedShellCommand(
  resolved: ResolvedSpawnCommand,
  command: string,
): ResolvedSpawnCommand {
  if (resolved.cwdDialect === "cmd") {
    return {
      ...resolved,
      args: [],
      file: command,
    };
  }

  if (resolved.shell === false && resolved.args[0] === "-c" && resolved.usesLoginShell === true) {
    const useLoginShell = resolved.args[1] === "-l";
    return {
      ...resolved,
      args: useLoginShell ? ["-c", "-l", command] : ["-c", command],
    };
  }

  return {
    ...resolved,
    args: [],
    file: command,
  };
}

export const applyResolvedShellCommandForTest = applyResolvedShellCommand;

export function defaultCwdDialect(platform: NodeJS.Platform): ExecutionShellDialect {
  return platform === "win32" ? "cmd" : "posix";
}

function resolveShell(
  shell: true | string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): true | string {
  if (typeof shell === "string") return shell;
  if (platform === "win32") {
    return getEnvValue(env, "ComSpec", "win32") ?? "cmd.exe";
  }
  return true;
}

function resolveWindowsExecutable(
  file: string,
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
  },
): string {
  const exists = options.exists ?? existsSync;
  const candidates = windowsExecutableCandidates(file, options.env, options.cwd);
  return candidates.find((candidate) => exists(candidate)) ?? file;
}

function isWindowsCommandShim(file: string): boolean {
  return WINDOWS_COMMAND_SHIM_EXTENSIONS.has(extname(file).toLowerCase());
}

function createCmdShimArgs(file: string, args: string[]): string[] {
  const commandLine = [file, ...args].map(quoteCmdArgument).join(" ");
  return ["/d", "/s", "/c", commandLine];
}

function quoteCmdArgument(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"%&()<>^|]/.test(value)) return value;
  return `"${value.replace(/(["%&()<>^|])/g, "^$1")}"`;
}

function setEnvKey(
  env: Record<string, string>,
  key: string,
  value: string,
  platform: NodeJS.Platform,
): void {
  deleteEnvKey(env, key, platform);
  env[key] = value;
}

function deleteEnvKey(env: Record<string, string>, key: string, platform: NodeJS.Platform): void {
  if (platform !== "win32") {
    delete env[key];
    return;
  }

  const lowerKey = key.toLowerCase();
  for (const existingKey of Object.keys(env)) {
    if (existingKey.toLowerCase() === lowerKey) {
      delete env[existingKey];
    }
  }
}

function getEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return env[key];
  const lowerKey = key.toLowerCase();
  const actualKey = Object.keys(env).find((candidate) => candidate.toLowerCase() === lowerKey);
  return actualKey ? env[actualKey] : undefined;
}
