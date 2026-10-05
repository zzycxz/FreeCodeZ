export function isSedInPlaceOption(word: string): boolean {
  return word.startsWith("-i") || word === "--in-place" || word.startsWith("--in-place=");
}

export function jqCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg) continue;
    if (isJqDangerousOption(arg)) return true;
    if (arg === "--") return jqFilterIsDangerous(args[index + 1] ?? "");
    if (arg === "--indent") {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return jqFilterIsDangerous(arg);
  }
  return false;
}

function isJqDangerousOption(word: string): boolean {
  return (
    word === "-f" ||
    word.startsWith("-f") ||
    word === "-L" ||
    word.startsWith("-L") ||
    word === "--argfile" ||
    word.startsWith("--argfile=") ||
    word === "--from-file" ||
    word.startsWith("--from-file=") ||
    word === "--library-path" ||
    word.startsWith("--library-path=") ||
    word === "--rawfile" ||
    word.startsWith("--rawfile=") ||
    word === "--run-tests" ||
    word.startsWith("--run-tests=") ||
    word === "--slurpfile" ||
    word.startsWith("--slurpfile=")
  );
}

function jqFilterIsDangerous(filter: string): boolean {
  return (
    /\$ENV\b/.test(filter) ||
    /(^|[^A-Za-z0-9_$.])env(?=$|[^A-Za-z0-9_])/.test(filter) ||
    /(^|[^A-Za-z0-9_])(?:include|import)(?=$|[^A-Za-z0-9_])/.test(filter)
  );
}

export function sedCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  let firstScriptSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg) continue;
    if (isSedInPlaceOption(arg)) return true;
    if (arg === "-e" || arg === "--expression") {
      index += 1;
      if (sedScriptWritesToFile(args[index] ?? "")) return true;
      continue;
    }
    if (arg.startsWith("--expression=")) {
      if (sedScriptWritesToFile(arg.slice("--expression=".length))) return true;
      continue;
    }
    if (arg === "-l" || arg === "--line-length") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--line-length=")) continue;
    if (arg === "--") {
      const script = args[index + 1] ?? "";
      return sedScriptWritesToFile(script);
    }
    if (!arg.startsWith("-") && !firstScriptSeen) {
      firstScriptSeen = true;
      if (sedScriptWritesToFile(arg)) return true;
    }
  }
  return false;
}

// 0-1 修复（升级实施手册）：旧正则只认无地址前缀的命令位 w，实测三类绕过均被误判只读——
// ① s 命令的 w/e 后缀标志（`s/a/b/w /tmp/pwn` 写文件、`s/.*/cmd/e` GNU 执行替换结果）；
// ② 地址前缀后的 w（`/re/w f`、`1,2w f`、`\|re|w f`）；③ w 紧跟文件名（`w/tmp/x`）。
// 判定依据（BSD+GNU sed 实证，样本钉死在 bashReadonlyPolicyCallbacks.test.ts）：
// - s 后第三定界符的合法 flag 字母（g p i I m M d + 数字）不含 w/e，flags 区出现即非良性；
// - 命令位 w/W/e 无良性同形命令（分支标签只能跟在 b/t/T/: 之后），w 无论后跟什么都可能是文件名；
// - 宁误杀：误判只多一次审批弹窗，不阻断命令。
const SED_S_COMMAND_DANGEROUS_FLAG =
  /(?:^|[;{\n])[^;{\n]*?s([^a-zA-Z0-9\s\\])(?:\\.|[^\\\n])*?\1(?:\\.|[^\\\n])*?\1[a-zA-Z0-9]*[we]/;
const SED_ADDRESS_ATOMS =
  /(?:^|[;{\n}])\s*(?:(?:[0-9]+|\$)|\/(?:\\.|[^\/\\\n])*\/|\\([^a-zA-Z0-9\s])(?:\\.|[^\n])*?\1|[!~+,\s])*[wWe]/;

function sedScriptWritesToFile(script: string): boolean {
  return SED_S_COMMAND_DANGEROUS_FLAG.test(script) || SED_ADDRESS_ATOMS.test(script);
}

export function dateCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  const valueFlags = new Set(["-d", "--date", "-r", "--reference", "--rfc-3339"]);
  for (let index = 0; index < args.length; ) {
    const arg = args[index] ?? "";
    if (arg.startsWith("--") && arg.includes("=")) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      index += valueFlags.has(arg) ? 2 : 1;
      continue;
    }
    if (!arg.startsWith("+")) return true;
    index += 1;
  }
  return false;
}

export function psCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return args.some((arg) => !arg.startsWith("-") && /^[a-zA-Z]*e[a-zA-Z]*$/.test(arg));
}

export function pyrightCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return args.some((arg) => arg === "--watch" || arg === "-w");
}

export function manCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  const aproposFlags = new Set(["-k", "-f", "--apropos", "--whatis"]);
  const valueFlags = new Set(["-S", "-s"]);
  let isApropos = false;
  let afterDoubleDash = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-") && arg !== "-") {
      if (aproposFlags.has(arg)) isApropos = true;
      if (valueFlags.has(arg)) index += 1;
      continue;
    }
    afterDoubleDash = true;
    if (arg.includes("/")) return !isApropos;
  }
  return false;
}

export function lsofCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "+m" || arg.startsWith("+m")) return true;
    if (/^-[a-zA-Z]*i\S*@/.test(arg)) {
      const host = arg.slice(arg.indexOf("@") + 1).split(":")[0] ?? "";
      if (/[a-zA-Z]/.test(host)) return true;
    }
    if (/^-[a-zA-Z]*i$/.test(arg)) {
      const next = args[index + 1] ?? "";
      if (next.includes("@")) {
        const host = next.slice(next.indexOf("@") + 1).split(":")[0] ?? "";
        if (/[a-zA-Z]/.test(host)) return true;
      }
    }
  }
  return false;
}

const TPUT_DANGEROUS_CAPABILITIES = new Set([
  "clear",
  "flash",
  "if",
  "init",
  "iprog",
  "is1",
  "is2",
  "is3",
  "mc0",
  "mc4",
  "mc5",
  "mc5i",
  "mc5p",
  "pfkey",
  "pfloc",
  "pfx",
  "pfxl",
  "reset",
  "rf",
  "rmcup",
  "rs1",
  "rs2",
  "rs3",
  "smcup",
]);

export function tputCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  let afterDoubleDash = false;
  for (let index = 0; index < args.length; ) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      afterDoubleDash = true;
      index += 1;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-")) {
      if (arg === "-S") return true;
      if (!arg.startsWith("--") && arg.length > 2 && arg.includes("S")) return true;
      index += arg === "-T" ? 2 : 1;
      continue;
    }
    if (TPUT_DANGEROUS_CAPABILITIES.has(arg)) return true;
    index += 1;
  }
  return false;
}

export function ssCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  const keywords =
    /^(dst|src|dport|sport|and|or|not|eq|ne|ge|le|gt|lt|autobound|state|exclude|dev|fwmark|cgroup)$/;
  const valueKeywords = /^(state|exclude|dport|sport|dev|fwmark|cgroup)$/;
  const valueFlags = /^(-f|--family|-A|--query|--socket)$/;
  const positional: string[] = [];
  let afterDoubleDash = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-")) {
      if (valueFlags.test(arg)) index += 1;
      continue;
    }
    positional.push(arg);
  }

  const tokens = positional
    .join(" ")
    .split(/[\s()=!<>&|,]+/)
    .filter(Boolean);
  let skipValue = false;
  for (const token of tokens) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (keywords.test(token)) {
      skipValue = valueKeywords.test(token);
      continue;
    }
    if (
      /[g-zG-Z]/.test(token) ||
      (/[a-fA-F]/.test(token) && (token.includes(".") || !token.includes(":")))
    )
      return true;
  }
  return false;
}

const TEST_NUMERIC_OPERATORS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
const TEST_SAFE_NUMBER = /^-?(0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[0-9]+)$/;

export function testCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  if (
    args.some(
      (arg) => arg === "-v" || arg === "-R" || arg === "-a" || arg === "-o" || /\[/.test(arg),
    )
  )
    return true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (TEST_NUMERIC_OPERATORS.has(arg)) {
      for (const value of [args[index - 1], args[index + 1]]) {
        if (value !== undefined && !TEST_SAFE_NUMBER.test(value)) return true;
      }
    }
    if (arg === "-t") {
      const value = args[index + 1];
      if (value !== undefined && !TEST_SAFE_NUMBER.test(value)) return true;
    }
  }
  return false;
}

export const XARGS_TARGET_COMMANDS = new Set([
  "echo",
  "printf",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "head",
  "tail",
]);
const XARGS_VALUE_FLAGS = new Set(["-I", "-n", "-P", "-L", "-s", "-E", "-d"]);

export function xargsCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    let arg = args[index] ?? "";
    if (!arg) continue;
    if (arg === "--" && index + 1 < args.length) {
      index += 1;
      arg = args[index] ?? "";
    }
    if (arg.startsWith("-") && arg !== "-") {
      if (XARGS_VALUE_FLAGS.has(arg)) index += 1;
      continue;
    }
    return !XARGS_TARGET_COMMANDS.has(arg);
  }
  return false;
}

export function ghCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  for (const arg of args) {
    if (!arg) continue;
    let value = arg;
    if (arg.startsWith("-")) {
      const equalsIndex = arg.indexOf("=");
      if (equalsIndex === -1) continue;
      value = arg.slice(equalsIndex + 1);
      if (!value) continue;
    }
    if (!value.includes("/") && !value.includes("://") && !value.includes("@")) continue;
    if (value.includes("://") || value.includes("@")) return true;
    if ((value.match(/\//g) ?? []).length >= 2) return true;
  }
  return false;
}

const DOCKER_DANGEROUS_GLOBAL_FLAGS = [
  "-H",
  "-c",
  "--config",
  "--context",
  "--host",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
];
const DOCKER_DANGEROUS_SHORT_FLAGS = new Set(
  DOCKER_DANGEROUS_GLOBAL_FLAGS.filter((flag) => flag.length === 2).map((flag) => flag[1]),
);

export function dockerCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return hasDangerousDockerOption(args);
}

export function hasDangerousDockerOption(args: readonly string[]): boolean {
  return args.some((arg) => {
    if (
      DOCKER_DANGEROUS_GLOBAL_FLAGS.some(
        (flag) =>
          arg === flag ||
          arg.startsWith(`${flag}=`) ||
          (flag.length === 2 && arg.length > 2 && arg.startsWith(flag)),
      )
    )
      return true;
    const shortFlags = arg.match(/^-([A-Za-z]+)/)?.[1];
    if (shortFlags !== undefined && shortFlags.length >= 2) {
      for (const flag of shortFlags) {
        if (DOCKER_DANGEROUS_SHORT_FLAGS.has(flag)) return true;
      }
    }
    return false;
  });
}

export * from "./bash-readonly-policy-git-callbacks.js";
