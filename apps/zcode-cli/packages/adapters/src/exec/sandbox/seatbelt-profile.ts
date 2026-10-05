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
import { tmpdir } from "node:os";

export interface WorkspaceWriteSeatbeltInput {
  workspaceRoot: string;
  writableRoots?: readonly string[];
  /** 缺省用 os.tmpdir()；测试可注入。 */
  tmpDir?: string;
}

function sbplPath(path: string): string {
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return `"${trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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

  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow file-read*)",
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
