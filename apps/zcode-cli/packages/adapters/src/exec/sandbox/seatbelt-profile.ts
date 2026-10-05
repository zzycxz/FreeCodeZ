// E-S1：macOS seatbelt（sandbox-exec）workspace-write 策略模板（纯函数）。
// 策略（对齐《规格书-FreeCodeZ-沙箱执行隔离-实施版》R3）：
//   - 全盘读（allow file-read*）+ sysctl-read（缺它 node/V8 因读不到 hw.memsize
//     崩溃为 LowLevelAlloc overflow——本机实测）；
//   - 写默认拒绝，仅放行：workspace 根（**含 .git**——codex 默认只读 .git 导致
//     commit 被拒是已实测的反面教训，不抄）、用户 writableRoots、/tmp 族与
//     $TMPDIR、`/dev/null` literal（git 等重定向需要——实测缺它 git commit 必败）；
//   - 网络允许（allow network*；出网管控是独立项，不与本项耦合）；
//   - 进程族放行（process*）。旧族操作（signal*/sysctl*/mach*/ipc*）在新 macOS
//     seatbelt 或为非法或致 profile 行为异常——本机逐项实测后从模板剔除。
// 注意：sbpl 无注释语法；subpath 路径必须引号包裹且不带尾斜杠。
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface WorkspaceWriteSeatbeltInput {
  workspaceRoot: string;
  writableRoots?: readonly string[];
  /** 缺省用 os.tmpdir()；测试可注入。 */
  tmpDir?: string;
  /**
   * 0-9（升级实施手册）：凭据文件 deny 目标（测试可注入）。缺省按 shared-credentials
   * 同一构造解析（ZCODE_DATA_BASE_DIR 环境覆盖 → ~/.freecodez/v2/credentials.json）。
   */
  credentialDenyPath?: string;
}

function sbplPath(path: string): string {
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return `"${trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 解析凭据文件 deny 路径——与 adapters/src/auth/shared-credentials.ts 的
 * resolveSharedZCodeCredentialsPath 同一构造（含 ~ 展开与 ZCODE_DATA_BASE_DIR 覆盖），
 * 不在沙箱层手写第二套格式。前置检查（0-9 实施前置）：agent 调模型读的是同目录的
 * provider_config.json，凭据消费方（credentialService/oauth-refresh/搜索 key）全在
 * agent 进程内——沙箱只包 bash 子进程，deny 该文件不影响任何合法链路。
 */
function resolveCredentialDenyPath(env: Record<string, string | undefined>): string | undefined {
  const baseDir = env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
  const resolvedBase =
    baseDir === "~" ? homedir() : baseDir.startsWith("~/") ? join(homedir(), baseDir.slice(2)) : resolve(baseDir);
  return join(resolvedBase, ".freecodez", "v2", "credentials.json");
}

/** 生成 workspace-write 的 sbpl profile 字符串（操作集经本机 sandbox-exec 实测验证）。 */
export function buildWorkspaceWriteSeatbeltProfile(
  input: WorkspaceWriteSeatbeltInput,
): string {
  const writeRoots = [
    input.workspaceRoot,
    ...(input.writableRoots ?? []),
    input.tmpDir ?? defaultTmpDir(),
    "/tmp",
    "/private/tmp",
    "/var/tmp",
    "/private/var/tmp",
  ]
    .map((root) => root.trim())
    .filter((root) => root.length > 0)
    .map(sbplPath);
  // V9（升级实施手册）：全盘读 + 允许出网的组合下，沙箱内 `cat 凭据文件` 即可把密钥
  // 外传——只 deny credentials.json 这一个文件（不能 deny 整个数据目录：agent 的
  // provider config、任务库都在旁边）。seatbelt 语义为后匹配规则胜出，deny 行必须
  // 排在 (allow file-read*) 之后。
  const credentialDenyPath = input.credentialDenyPath ?? resolveCredentialDenyPath(process.env);

  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow file-read*)",
    `(deny file-read* (subpath ${sbplPath(credentialDenyPath)}))`,
    "(allow network*)",
    "(allow sysctl-read)",
    ...[...new Set(writeRoots)].map((root) => `(allow file-write* (subpath ${root}))`),
    '(allow file-write* (literal "/dev/null"))',
  ].join("\n");
}

function defaultTmpDir(): string {
  // 原实现误写成 process.tmpdir：Node 无此 API（运行时恒 undefined），守卫恒假
  // 导致永远回退 "/tmp"，macOS 上漏放行 per-user 临时目录（/var/folders/...）；
  // 且 @types/node 的 Process 类型无该属性，tsc 直接编译失败（TS2339）。
  // 正确 API 是 os.tmpdir()，顶层 import 内置模块不影响纯函数测试。
  return tmpdir();
}
