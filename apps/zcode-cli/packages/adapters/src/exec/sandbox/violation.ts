// E-S2：沙箱拒绝归因分类器（纯函数）。沙箱内失败的命令若不归因，模型只会看到
// 一个误导性的 EPERM（E2 实测 npm 报 EPERM 且不提路径），无法自我修正。本模块把
// 常见失败形态映射为结构化归因（类别 + 被拒路径 + 面向模型的修正指引），供执行
// 结果组装 ExecutionFailure{type:"sandbox_violation"} 与模型可见文案。
export type SandboxViolationCategory =
  | "write-denied" // 越界写（最常见：包管理器缓存、全局配置）
  | "read-denied" // 极少见（策略全盘读，出现即异常）
  | "spawn-denied" // 执行被拒
  | "network-denied" // 首期策略允许网络，出现即异常（保留给断网变体）
  | "unknown-sandbox-failure";

export interface SandboxViolationMatch {
  category: SandboxViolationCategory;
  /** 从 stderr 提取的被拒绝对路径（无则缺省）。 */
  deniedPath?: string;
  /** 面向模型的归因说明：发生了什么 + 怎么修正。 */
  message: string;
}

// 归因锚点（E2 实测收集）。检测改为两级：先做关键词门（任一命中才继续），
// 再按动词细分与提路径——npm 等工具把 code/syscall/path 分行输出，跨行正则
// 在大输出上既慢又脆，分级匹配稳得多。
const WRITE_DENIED_KEYWORDS = /\b(EPERM|EACCES|permission denied|read-only file system|operation not permitted)\b/i;
const SPAWN_DENIED_KEYWORDS = /\b(?:EPERM|EACCES)\b[^\n]*(?:spawn|exec)/i;
// EISDIR 不属于读拒绝：它是"把目录当文件操作"（如 cat 一个目录），并非沙箱
// 权限拦截；误归因会让模型以为策略拒绝读、给出错误修正方向，故从锚点剔除。
const READ_DENIED_KEYWORDS = /(?:EACCES|EPERM)[^\n]*(?:readdir|open for read)/i;
const SANDBOX_EXEC_KEYWORDS = /sandbox-exec:/i;
const NETWORK_DENIED_KEYWORDS = /(network is unreachable|connection refused by sandbox|sandbox denied network)/i;

// 路径形态：POSIX 绝对路径（/…）或 Windows 盘符路径（C:\… / C:/…）。Windows
// 沙箱（低完整级 MIC）的报错只含盘符路径，缺这半边时归因消息拿不到被拒路径。
const POSIX_ABSOLUTE_PATH = "\\/[^\\s'\"`]+";
const WINDOWS_DRIVE_PATH = "[A-Za-z]:[\\\\/][^\\s'\"`]+";

// 显式 path 字段优先（npm/pnpm/ESBuild 风格："... path /abs/path" 或 "path: /abs"）。
const EXPLICIT_PATH_RE = new RegExp(
  `(?:^|\\n)[^\\n]*?\\b(?:path|file|dest|target|filename)\\b[:=]?\\s+(${POSIX_ABSOLUTE_PATH}|${WINDOWS_DRIVE_PATH})`,
  "i",
);

/** 报错文本里第一个绝对路径 token（兜底）。 */
const ABSOLUTE_PATH_RE = new RegExp(
  `(?:^|[\\s'\`(=])((${POSIX_ABSOLUTE_PATH})|(${WINDOWS_DRIVE_PATH}))`,
);

export function classifySandboxViolation(input: {
  stderr: string;
  stdout?: string;
}): SandboxViolationMatch | undefined {
  const haystacks = [input.stderr, input.stdout ?? ""].filter((text) => text.trim().length > 0);
  const stderr = input.stderr;
  for (const haystack of haystacks) {
    let category: SandboxViolationCategory | undefined;
    let what = "the sandbox denied a file write outside the allowed roots";
    if (SANDBOX_EXEC_KEYWORDS.test(haystack)) {
      category = "write-denied";
      what = "the sandbox rejected an operation";
    } else if (NETWORK_DENIED_KEYWORDS.test(haystack)) {
      category = "network-denied";
      what = "the sandbox denied a network operation";
    } else if (SPAWN_DENIED_KEYWORDS.test(haystack)) {
      category = "spawn-denied";
      what = "the sandbox denied launching a program";
    } else if (READ_DENIED_KEYWORDS.test(haystack)) {
      category = "read-denied";
      what = "the sandbox denied a read (unexpected: policy allows all reads)";
    } else if (WRITE_DENIED_KEYWORDS.test(haystack)) {
      category = "write-denied";
    }
    if (!category) continue;

    const deniedPath =
      firstMatch(haystack, EXPLICIT_PATH_RE) ?? firstMatch(haystack, ABSOLUTE_PATH_RE);
    return {
      category,
      ...(deniedPath ? { deniedPath } : {}),
      message: buildModelGuidance(category, what, deniedPath),
    };
  }
  // 关键词门都没过但 stderr 出现 EPERM 家族字样：归为未知沙箱失败（仍比裸错误可读）。
  if (/\b(EPERM|EACCES|Operation not permitted)\b/i.test(stderr)) {
    return {
      category: "unknown-sandbox-failure",
      message: buildModelGuidance(
        "unknown-sandbox-failure",
        "an operation was denied by the sandbox",
        firstMatch(stderr, ABSOLUTE_PATH_RE),
      ),
    };
  }
  return undefined;
}

function firstMatch(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  if (!match) return undefined;
  // EXPLICIT_PATH_RE 单捕获组；ABSOLUTE_PATH_RE 用两个捕获组分别对应两种路径形态。
  const raw = match[1] ?? match[2] ?? match[3];
  // 尾部常见标点（cp/ssh 风格 "path:"、逗号、句号、括号包裹形态）剥离后再校验
  // 绝对路径形态（路径形态统一后排除集不再含 ')'，在此补剥）。
  const trimmed = raw?.trim().replace(/^["']|["':,.)]+$/g, "");
  if (!trimmed) return undefined;
  return isAbsoluteLikePath(trimmed) ? trimmed : undefined;
}

function isAbsoluteLikePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function buildModelGuidance(
  category: SandboxViolationCategory,
  what: string,
  deniedPath: string | undefined,
): string {
  const pathPart = deniedPath ? ` (denied path: ${deniedPath})` : "";
  if (category === "write-denied" && deniedPath) {
    const hint = /(\.npm|\.cache|node_modules\/\.cache|\.cargo|\.rustup|\.config)/.test(deniedPath)
      ? " This looks like a package-manager cache/config directory outside the workspace; consider redirecting the cache into the workspace (e.g. npm_config_cache=<workspace>/.tmp/npm) instead of writing outside."
      : " If this write is required, ask the user to add the directory to sandbox writable roots.";
    return `Sandboxed command failed: ${what}${pathPart}.${hint}`;
  }
  return `Sandboxed command failed: ${what}${pathPart}. If the operation is required, ask the user to adjust the sandbox policy.`;
}

