// ============================================================
// U2-1a（移植自 ZCode 3.15.1 上游 matchDangerousCommand 引擎，zcode.cjs@≈7352695-7360900
// 逐函数对照重建：F4=parseOptions / t1=optionTable / j4=enabled / B4=settleRule /
// lvo=unwrapCommand / fvo=matchDangerousCommand / Oba=matchInvocation / tvo=matchGit /
// ivo/rvo/svo=cmd 方言与 find——posix/bash 方言 1:1；cmd/git-bash 方言属上游 Windows
// 多 shell 支持，FC 的 Bash 工具全平台走 bash，不适用（spec U2-1 范围注记））
// ============================================================
// 语义：guarded 档的「危险命令」判定。纯静态规则引擎（非 LLM）：shell 解析 → 剥
// 包装器（sudo/env/time 族）→ 规则表匹配。命中 → 单次 ask；未命中/unsupported →
// 等同 yolo 放行。保守方向（同上游）：命令 >10000 字符 / 解析失败 / 不支持语法 /
// 动态词且无规则命中 → 不询问（防误杀；界内破坏由审批/沙箱负责）。
import { analyzeBashCommand, type BashCommandInvocation } from "./handlers/bash-command-parser.js";

export interface DangerousCommandMatch {
  /** 规则号（safety.bash.*），进 ask 的 ruleId；UI「始终允许相同命令」按它落规则。 */
  ruleId: string;
  /** 面向用户的确认说明。 */
  reason: string;
}

/** 上游 fvo 的三态结果：matched=规则命中（ask）；unsupported=解析失败/动态词（保守放行）；
 *  notMatched=安全命令（等同 yolo 放行）。unsupported 与 notMatched 运行时同向（都不询问），
 *  但诊断语义不同，按上游保留区分。 */
export type DangerousCommandResult =
  | ({ status: "matched" } & DangerousCommandMatch)
  | { status: "unsupported" }
  | { status: "notMatched" };

/** 词模型（上游 word：value/dynamic/hasUnquotedGlob；FC 解析器无词级 dynamic，用
 * invocation 级 hasDynamicWords 在 fvo 层标记）。 */
interface Word {
  readonly value: string;
  readonly dynamic: boolean;
  readonly hasUnquotedGlob: boolean;
}

function word(value: string): Word {
  return { value, dynamic: false, hasUnquotedGlob: /[*?[]/u.test(value) };
}

// ---- 上游 t1：optionTable（flag=无值旗标 / value=带值旗标 / optional=操作数位旗标）----
type OptionFlagKind = "flag" | "value" | "optional";
type OptionTable = Record<string, OptionFlagKind>;

function optionTable(flags = "", flagsWithValue = "", operandFlags = ""): OptionTable {
  const table: Record<string, OptionFlagKind> = {};
  for (const flag of flags.split(/\s+/).filter(Boolean)) table[flag] = "flag";
  for (const flag of flagsWithValue.split(/\s+/).filter(Boolean)) table[flag] = "value";
  for (const flag of operandFlags.split(/\s+/).filter(Boolean)) table[flag] = "optional";
  return table;
}

interface ParsedOptions {
  readonly flags: string[];
  readonly operands: Word[];
  readonly unsupported: boolean;
}

// ---- 上游 F4：parseOptions。短旗标簇展开（-rf→-r,-f）、长旗标 =值切分、-- 终止、
// ordering=stop-at-operand（首操作数后全是操作数）/interspersed、unknown=abort/continue ----
function parseOptions(
  words: readonly Word[],
  table: OptionTable,
  mode: { ordering: "stop-at-operand" | "interspersed"; unknown: "abort" | "continue" },
): ParsedOptions {
  const flags: string[] = [];
  const operands: Word[] = [];
  let unsupported = false;
  let endOfFlags = false;
  for (let index = 0; index < words.length; index += 1) {
    const current = words[index]!;
    if (!endOfFlags && !current.dynamic && current.value === "--") {
      endOfFlags = true;
      continue;
    }
    if (endOfFlags || current.dynamic || !current.value.startsWith("-") || current.value === "-") {
      operands.push(current);
      if (mode.ordering === "stop-at-operand") {
        operands.push(...words.slice(index + 1));
        break;
      }
      continue;
    }
    const isLong = current.value.startsWith("--");
    const eq = current.value.indexOf("=");
    const parts = isLong
      ? [eq < 0 ? current.value : current.value.slice(0, eq)]
      : Array.from(current.value.slice(1), (char) => `-${char}`);
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex]!;
      const kind = table[part];
      const carriesValue = isLong ? eq >= 0 : partIndex < parts.length - 1;
      if (!kind || (kind === "flag" && isLong && carriesValue)) {
        unsupported = true;
        if (mode.unknown === "abort") return { flags, operands, unsupported };
        continue;
      }
      flags.push(part);
      if (kind === "value" && !carriesValue) {
        index += 1;
        if (words[index] === undefined) unsupported = true;
      }
      if (kind !== "flag") break;
    }
  }
  return { flags, operands, unsupported };
}

// ---- 上游 j4：enabled——顺序敏感（后面的 noneOf 旗标取消前面 anyOf 的命中）----
function enabled(flags: readonly string[], anyOf: readonly string[], noneOf: readonly string[] = []): boolean {
  let result = false;
  for (const flag of flags) {
    if (anyOf.includes(flag)) result = true;
    if (noneOf.includes(flag)) result = false;
  }
  return result;
}

// ---- 上游 B4：settleRule——条件命中优先；否则 unsupported→undefined（不询问）、
// 未命中→false（放行）----
function settleRule(match: string | false, parsed: ParsedOptions): string | false | undefined {
  return match || (parsed.unsupported ? undefined : false);
}

function hasHelp(flags: readonly string[]): boolean {
  return flags.includes("--help") || flags.includes("-h");
}

// ---- 上游 lvo：unwrapCommand（sudo/env/time 族带值旗标表 + VAR=val 赋值跳过）----
const WRAPPER_FLAG_TABLES: Record<string, OptionTable> = {
  env: optionTable("-i --ignore-environment -0 --null -v --debug", "-u --unset -C --chdir"),
  time: optionTable("-a --append -p --portability -v --verbose -q --quiet", "-o --output -f --format"),
  sudo: optionTable(
    "-A --askpass -b --background -E --preserve-env -H --set-home -K --remove-timestamp -k --reset-timestamp -n --non-interactive -S --stdin",
    "-u --user -g --group -h --host -p --prompt -C --close-from -T --command-timeout -D --chdir -R --chroot",
  ),
};
const STOP_AT_OPERAND_ABORT = { ordering: "stop-at-operand", unknown: "abort" } as const;
const INTERSPERSED_CONTINUE = { ordering: "interspersed", unknown: "continue" } as const;

function unwrapCommand(argv: readonly string[]): readonly string[] | undefined {
  let current = argv;
  for (;;) {
    if (current.length === 0) return undefined;
    const head = (current[0] ?? "").toLowerCase();
    const table = WRAPPER_FLAG_TABLES[head];
    if (!table) return current;
    const parsed = parseOptions(
      current.slice(1).map(word),
      table,
      STOP_AT_OPERAND_ABORT,
    );
    if (parsed.unsupported) return undefined;
    current = parsed.operands.map((operand) => operand.value);
    if (head === "env" || head === "sudo") {
      while (current[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(current[0] ?? "")) {
        current = current.slice(1);
      }
    }
  }
}

// ---- rm（上游 dvo 表）：递归旗标（abort 遍）/ 多操作数或未引号 glob（continue 遍）----
const RM_TABLE = optionTable(
  "-r -R --recursive -f --force -i -I --one-file-system --preserve-root --no-preserve-root -v --verbose -d --dir --help --version",
  "",
  "--interactive",
);

function matchRm(argv: readonly Word[]): string | false | undefined {
  const abortPass = parseOptions(argv, RM_TABLE, STOP_AT_OPERAND_ABORT);
  const continuePass = parseOptions(argv, RM_TABLE, INTERSPERSED_CONTINUE);
  return settleRule(
    (enabled(abortPass.flags, ["-r", "-R", "--recursive"]) ||
      continuePass.operands.length >= 2 ||
      continuePass.operands.some((operand) => operand.hasUnquotedGlob)) &&
      "remove-critical-path",
    continuePass,
  );
}

// ---- dd/mount/umount/mkfs（上游 system-storage 规则）----
function matchSystemStorage(command: string, argv: readonly Word[]): string | false {
  if (argv.length === 1 && !argv[0]!.dynamic && ["--help", "--version"].includes(argv[0]!.value)) {
    return false;
  }
  if (command === "mount" && argv.length === 0) return false;
  return "system-storage";
}

// ---- rsync（上游 pvo 删除旗标集；-n/--dry-run 豁免）----
const RSYNC_DELETE_FLAGS = [
  "--delete",
  "--del",
  "--delete-before",
  "--delete-during",
  "--delete-delay",
  "--delete-after",
  "--delete-excluded",
];
const RSYNC_TABLE = optionTable(
  `-a -r -v -q -z -h -P -p -t -g -o -D -l -H -A -X -u -c -n --dry-run --archive --recursive --verbose --quiet --compress --progress --partial --checksum --update --numeric-ids --ignore-errors --force --help --version ${RSYNC_DELETE_FLAGS.join(" ")}`,
  "-e --rsh -f --filter --include --exclude --include-from --exclude-from --files-from --rsync-path --log-file --out-format --backup-dir --suffix --chmod --chown --max-delete --timeout --bwlimit --compare-dest --copy-dest --link-dest",
);

function matchRsync(argv: readonly Word[]): string | false | undefined {
  const parsed = parseOptions(argv, RSYNC_TABLE, INTERSPERSED_CONTINUE);
  return settleRule(
    !parsed.flags.some((flag) => ["-n", "--dry-run", "--help", "--version"].includes(flag)) &&
      parsed.flags.some((flag) => RSYNC_DELETE_FLAGS.includes(flag)) &&
      "rsync-delete",
    parsed,
  );
}

// ---- find -delete（上游 rvo：谓词区严格白名单，未知谓词→undefined 不询问）----
const FIND_SAFE_NO_VALUE_FLAGS = new Set(
  "-H -L -P -O0 -O1 -O2 -O3 -depth -d -x -xdev -mount -ignore_readdir_race -noignore_readdir_race -daystart -follow -noleaf -true -false -empty -readable -writable -executable -print -print0 -ls -prune -quit -a -and -o -or -not ! ( ) ,".split(
    " ",
  ),
);
const FIND_VALUE_FLAGS = new Set(
  "-D -f -name -iname -path -ipath -wholename -iwholename -regex -iregex -regextype -type -xtype -size -user -group -uid -gid -perm -links -inum -samefile -newer -anewer -cnewer -atime -ctime -mtime -amin -cmin -mmin -used -maxdepth -mindepth -printf -fprint -fprint0 -fls -files0-from".split(
    " ",
  ),
);
const FIND_EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

function matchFindDelete(argv: readonly Word[]): string | false | undefined {
  let predicatesStarted = false;
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]!;
    if (!predicatesStarted && !current.value.startsWith("-") && !["!", "("].includes(current.value)) {
      continue;
    }
    if (current.dynamic) return undefined;
    if (["-H", "-L", "-P", "-O0", "-O1", "-O2", "-O3", "-d", "-x"].includes(current.value) && !predicatesStarted) {
      continue;
    }
    if (["-D", "-f"].includes(current.value) && !predicatesStarted) {
      index += 1;
      if (argv[index] === undefined) return undefined;
      continue;
    }
    predicatesStarted = true;
    if (current.value === "-delete") return "find-delete";
    if (FIND_EXEC_FLAGS.has(current.value)) {
      let terminated = false;
      for (index += 1; index < argv.length; index += 1) {
        const inner = argv[index]!;
        if (
          !inner.dynamic &&
          (inner.value === ";" ||
            (inner.value === "+" && argv[index - 1]?.value === "{}" && ["-exec", "-execdir"].includes(current.value)))
        ) {
          terminated = true;
          break;
        }
      }
      if (!terminated) return undefined;
    } else if (
      current.value === "-fprintf" ||
      FIND_VALUE_FLAGS.has(current.value) ||
      /^-newer[acmBt][acmBt]$/.test(current.value)
    ) {
      index += current.value === "-fprintf" ? 2 : 1;
      if (argv[index] === undefined) return undefined;
    } else if (!FIND_SAFE_NO_VALUE_FLAGS.has(current.value)) {
      return undefined;
    }
  }
  return false;
}

// ---- git（上游 tvo + 旗标表）----
const GIT_HELP = "-h --help";
const GIT_COMMON_QUIET = `${GIT_HELP} -q --quiet -v --verbose`;
const GIT_GLOBAL_TABLE = optionTable(
  "--no-pager -P --paginate -p --literal-pathspecs --glob-pathspecs --noglob-pathspecs --icase-pathspecs --bare --no-replace-objects --no-optional-locks",
  "-C --git-dir --work-tree --namespace -c --config-env --super-prefix",
);
const GIT_RESET_TABLE = optionTable(
  `${GIT_COMMON_QUIET} --hard --soft --mixed --merge --keep -p --patch -N --intent-to-add --no-refresh --refresh --recurse-submodules --no-recurse-submodules`,
);
const GIT_CLEAN_TABLE = optionTable(
  `${GIT_COMMON_QUIET} -f --force -d -x -X -n --dry-run --no-dry-run -i --interactive`,
  "-e --exclude",
);
const GIT_PUSH_TABLE = optionTable(
  `${GIT_COMMON_QUIET} -f --force --no-force --mirror --no-mirror -n --dry-run --no-dry-run --no-force-with-lease --force-if-includes --no-force-if-includes --all --branches --tags --delete -d --prune --atomic --no-atomic --porcelain --follow-tags --no-follow-tags --set-upstream -u --thin --no-thin --progress --no-progress --ipv4 -4 --ipv6 -6`,
  "--repo --receive-pack --exec -o --push-option",
  "--force-with-lease --signed --recurse-submodules",
);
const GIT_CHECKOUT_TABLE = optionTable(
  `${GIT_COMMON_QUIET} -f --force --no-force --detach --ours --theirs -m --merge --conflict -p --patch --ignore-other-worktrees --recurse-submodules --no-recurse-submodules --no-overlay`,
);
const GIT_RESTORE_TABLE = optionTable(
  `${GIT_COMMON_QUIET} -S --staged --no-staged -W --worktree --no-worktree --ours --theirs -m --merge --conflict -p --patch --ignore-unmerged --overlay`,
  "--source",
);
const GIT_STASH_TABLE = optionTable(GIT_HELP);
const GIT_FORCE = ["-f", "--force"];

/** checkout/restore 的「整树丢弃」操作数形态（上游 evo）：当前目录/仓库根。 */
const WHOLE_TREE_OPERANDS = new Set([".", "./", ":/"]);

function matchGit(argv: readonly Word[]): string | false | undefined {
  const globalParsed = parseOptions(argv, GIT_GLOBAL_TABLE, STOP_AT_OPERAND_ABORT);
  if (globalParsed.unsupported || globalParsed.operands[0]?.dynamic) return undefined;
  const [sub, ...rest] = globalParsed.operands;
  if (!sub) return false;
  const dryRunFlags = ["-n", "--dry-run"];
  switch (sub.value) {
    case "reset": {
      const parsed = parseOptions(rest, GIT_RESET_TABLE, INTERSPERSED_CONTINUE);
      if (hasHelp(parsed.flags)) return false;
      if (parsed.operands[0]?.dynamic) return undefined;
      return settleRule(
        enabled(parsed.flags, ["--hard"], ["--soft", "--mixed", "--merge", "--keep", "-p", "--patch"]) &&
          "git-reset-hard",
        parsed,
      );
    }
    case "clean": {
      const parsed = parseOptions(rest, GIT_CLEAN_TABLE, INTERSPERSED_CONTINUE);
      if (hasHelp(parsed.flags)) return false;
      return settleRule(
        !enabled(parsed.flags, dryRunFlags, ["--no-dry-run"]) &&
          enabled(parsed.flags, GIT_FORCE, ["--no-force"]) &&
          "git-clean-force",
        parsed,
      );
    }
    case "push": {
      const parsed = parseOptions(rest, GIT_PUSH_TABLE, INTERSPERSED_CONTINUE);
      if (hasHelp(parsed.flags)) return false;
      const refspecs = parsed.flags.includes("--repo") ? parsed.operands : parsed.operands.slice(1);
      return settleRule(
        !enabled(parsed.flags, dryRunFlags, ["--no-dry-run"]) &&
          (enabled(parsed.flags, GIT_FORCE, ["--no-force"]) ||
            enabled(parsed.flags, ["--force-with-lease"], ["--no-force-with-lease"]) ||
            enabled(parsed.flags, ["--mirror"], ["--no-mirror"]) ||
            refspecs.some((operand) => !operand.dynamic && operand.value.startsWith("+"))) &&
          "git-push-force",
        parsed,
      );
    }
    case "checkout": {
      const parsed = parseOptions(rest, GIT_CHECKOUT_TABLE, INTERSPERSED_CONTINUE);
      if (hasHelp(parsed.flags)) return false;
      return settleRule(
        (enabled(parsed.flags, GIT_FORCE, ["--no-force"]) ||
          parsed.operands.some((operand) => !operand.dynamic && WHOLE_TREE_OPERANDS.has(operand.value))) &&
          "git-discard-tree",
        parsed,
      );
    }
    case "restore": {
      const parsed = parseOptions(rest, GIT_RESTORE_TABLE, INTERSPERSED_CONTINUE);
      if (hasHelp(parsed.flags)) return false;
      // 上游语义：staged（-S/--staged 且未带 -W/--worktree）不拦——只动暂存区可逆；
      // 工作树丢弃才确认。
      const stagedOnly =
        enabled(parsed.flags, ["-S", "--staged"], ["--no-staged"]) &&
        !enabled(parsed.flags, ["-W", "--worktree"], ["--no-worktree"]);
      return settleRule(
        !stagedOnly &&
          parsed.operands.some((operand) => !operand.dynamic && WHOLE_TREE_OPERANDS.has(operand.value)) &&
          "git-discard-tree",
        parsed,
      );
    }
    case "stash": {
      if (rest[0]?.dynamic) return undefined;
      if (rest[0]?.value !== "clear") return false;
      const parsed = parseOptions(rest.slice(1), GIT_STASH_TABLE, INTERSPERSED_CONTINUE);
      return settleRule(!hasHelp(parsed.flags) && "git-stash-clear", parsed);
    }
    case "worktree": {
      if (rest[0]?.dynamic) return undefined;
      if (rest[0]?.value !== "remove") return false;
      const parsed = parseOptions(rest.slice(1), optionTable(`${GIT_HELP} -f --force --no-force`), INTERSPERSED_CONTINUE);
      if (hasHelp(parsed.flags)) return false;
      return settleRule(
        enabled(parsed.flags, GIT_FORCE, ["--no-force"]) && "git-worktree-force-remove",
        parsed,
      );
    }
    default:
      return false;
  }
}

// ---- 解释器（上游 Rba）：-c 脚本串递归再解析 ----
const INTERPRETER_COMMANDS = new Set([
  "bash",
  "sh",
  "zsh",
  "cmd",
  "powershell",
  "pwsh",
  "eval",
  "source",
  ".",
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
]);

const MAX_COMMAND_LENGTH = 10_000;

function isMkfsVariant(command: string): boolean {
  return /^mkfs\.[a-zA-Z0-9_-]+$/.test(command);
}

function matchInvocation(
  invocation: BashCommandInvocation,
  depth: number,
): string | false | undefined {
  const argv = invocation.argv;
  if (argv.length === 0) return undefined;
  const head = (argv[0] ?? "").split("/").pop()?.toLowerCase() ?? "";
  const args = argv.slice(1).map(word);

  // 解释器 -c 脚本串递归（上游由解析器内联处理，FC 在此显式递归；同灾难地板模式）。
  if (INTERPRETER_COMMANDS.has(head)) {
    const scriptIndex = args.findIndex((arg) => arg.value === "-c");
    if (scriptIndex !== -1) {
      const script = args[scriptIndex + 1];
      if (script) {
        // 递归走裸规则函数：返回不带前缀的规则串，避免 safety.bash. 双拼。
        return matchRaw(script.value, depth + 1);
      }
    }
    return undefined;
  }

  if (head === "git") return matchGit(args);
  if (head === "find") return matchFindDelete(args);
  if (head === "rm") return matchRm(args);
  if (["dd", "mount", "umount", "mkfs"].includes(head) || isMkfsVariant(head)) {
    return matchSystemStorage(head, args);
  }
  if (head === "rsync") return matchRsync(args);
  return false;
}

/**
 * 判定一条 bash 命令是否命中 guarded 危险规则（上游 fvo）。返回 undefined=unsupported
 * （解析失败/动态词等，保守放行不询问）；false=未命中（等同 yolo 放行）；命中=规则串。
 * 复合命令（管道/&&/;）任一段命中即命中；剥包装器与解释器 -c 递归后判定。
 */
/** 内部裸规则匹配（上游 fvo 主体）：返回原始规则串（不带 safety.bash. 前缀）/
 * false=notMatched / undefined=unsupported。递归入口也走这里，避免前缀双拼。 */
function matchRaw(command: string, depth: number): string | false | undefined {
  if (depth >= 4) return undefined;
  if (command.length > MAX_COMMAND_LENGTH) return undefined;
  const analysis = analyzeBashCommand(command);
  if (analysis.hasParseErrors || analysis.hasUnsupportedSyntax) return undefined;
  let sawUnsupported = false;
  for (const invocation of analysis.commands) {
    const unwrapped = unwrapCommand(invocation.argv);
    if (unwrapped === undefined || unwrapped.length === 0) {
      sawUnsupported = true;
      continue;
    }
    const hit = matchInvocation({ ...invocation, argv: [...unwrapped] }, depth);
    if (typeof hit === "string") return hit;
    // 上游语义：子匹配 unsupported 或该段含动态词 → 聚合 unsupported；未命中→notMatched。
    if (hit === undefined || invocation.hasDynamicWords) {
      sawUnsupported = true;
    }
  }
  return sawUnsupported ? undefined : false;
}

export function matchDangerousCommand(
  command: string,
  depth = 0,
): DangerousCommandResult {
  const hit = matchRaw(command, depth);
  if (typeof hit === "string") {
    return {
      status: "matched",
      ruleId: `safety.bash.${hit}`,
      reason: "Dangerous command requires your approval for this execution",
    };
  }
  return hit === undefined ? { status: "unsupported" } : { status: "notMatched" };
}
