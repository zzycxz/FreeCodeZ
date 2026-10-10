// E-S4 测试：①bwrap 参数纯函数（基础旗标序/workspace bind/去重/tmp 归一/不存在根跳过）；
// ②Linux 包装器（argv/shell 两模式、bwrap 缺失 fail-open）；
// ③平台分发器矩阵（darwin→seatbelt、linux→bwrap、win32→unsupported-platform、
// 未启用快速路径）；④Linux+bwrap 真集成（环境具备才跑）。
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  BWRAP_CANDIDATE_PATHS,
  buildWorkspaceWriteBwrapArgs,
  findBwrapPath,
  wrapCommandWithBwrap,
} from "../src/exec/sandbox/bwrap-exec.js";
import { wrapCommandWithSandbox } from "../src/exec/sandbox/wrap.js";
import { SANDBOX_EXEC_PATH } from "../src/exec/sandbox/seatbelt-exec.js";

const WORKSPACE_DIR = mkdtempSync(join(realpathSync(tmpdir()), "sbx-bwrap-ws-"));
const WORKSPACE = WORKSPACE_DIR;

function argvCommand() {
  return { args: ["-c", "ls"], cwdDialect: "posix" as const, file: "/bin/bash", shell: false };
}

test("bwrap args：基础旗标（ro-bind 全盘/dev/proc/tmpfs）+ workspace bind", () => {
  // tmpDir 显式指向 workspace：既测去重，又避免 macOS 真实 TMPDIR 带来平台差异的额外 bind。
  const args = buildWorkspaceWriteBwrapArgs({ workspaceRoot: WORKSPACE, tmpDir: WORKSPACE });
  assert.deepEqual(args.slice(0, 9), [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
  ]);
  // bind 源必须真实存在（不存在会让 bwrap 报错），workspace 用临时目录保证存在。
  assert.deepEqual(args.slice(9), ["--bind", WORKSPACE, WORKSPACE]);
});

test("bwrap args：tmpDir=/tmp 不重复 bind；writableRoots 去重；不存在根跳过", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sbx-bwrap-extra-"));
  try {
    const args = buildWorkspaceWriteBwrapArgs({
      workspaceRoot: WORKSPACE,
      writableRoots: [dir, dir, "/definitely/not/here", "/tmp"],
      tmpDir: "/tmp",
    });
    const binds = args.filter((_, index) => args[index - 1] === "--bind");
    assert.ok(binds.includes(WORKSPACE));
    assert.ok(binds.includes(dir), "真实存在的 writableRoot 应 bind 且去重");
    assert.equal(binds.filter((path) => path === "/tmp").length, 0, "tmpDir=/tmp 由 tmpfs 覆盖");
    assert.ok(!binds.includes("/definitely/not/here"), "不存在的 bind 源必须跳过");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bwrap args：真实存在的 tmpDir 单独 bind（ro-bind 的 /tmp 之外）", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "sbx-bwrap-"));
  try {
    const args = buildWorkspaceWriteBwrapArgs({ workspaceRoot: dir, tmpDir: dir });
    const binds = args.filter((_, index) => args[index - 1] === "--bind");
    assert.ok(binds.includes(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bwrap wrap：argv 与 shell 模式统一抬进 bwrap；未启用/逃生原样返回", () => {
  const wrapped = wrapCommandWithBwrap({
    policy: { enabled: true, mode: "workspace-write", workspaceRoot: WORKSPACE },
    command: argvCommand(),
  });
  if (findBwrapPath()) {
    assert.equal(wrapped.sandboxed, true);
    assert.equal(wrapped.command.file, findBwrapPath());
    assert.equal(wrapped.command.args.at(-3), "--");
    assert.equal(wrapped.command.args.at(-2), "/bin/bash");
  } else {
    // 本机（mac/无 bwrap 的 linux）验证 fail-open：原样执行 + 可观测原因。
    assert.equal(wrapped.sandboxed, false);
    assert.equal(wrapped.skippedReason, "sandbox-exec-missing");
  }

  const shellWrapped = wrapCommandWithBwrap({
    policy: { enabled: true, mode: "workspace-write", workspaceRoot: WORKSPACE },
    command: { args: [], cwdDialect: "posix" as const, file: "echo hi", shell: true },
  });
  if (shellWrapped.sandboxed) {
    // 与 seatbelt 同因：必须以 `-- shell -c 命令文本` 收尾（缺 -c 时 bash 把
    // 命令文本当脚本文件名执行，命令必败）。
    assert.deepEqual(shellWrapped.command.args.slice(-3), ["/bin/bash", "-c", "echo hi"]);
  }

  const disabled = wrapCommandWithBwrap({ policy: undefined, command: argvCommand() });
  assert.equal(disabled.sandboxed, false);
  assert.equal(disabled.skippedReason, "disabled");

  const bypassed = wrapCommandWithBwrap({
    policy: {
      enabled: true,
      mode: "workspace-write",
      workspaceRoot: WORKSPACE,
      dangerouslyDisableSandbox: true,
    },
    command: argvCommand(),
  });
  assert.equal(bypassed.sandboxed, false);

  // 激活语义回归锚：历史遥测形态 {enabled:true, 无 mode} 不得激活（红线：默认 off）。
  const telemetryShape = wrapCommandWithBwrap({
    policy: { enabled: true },
    command: argvCommand(),
  });
  assert.equal(telemetryShape.sandboxed, false);
});

test("分发器：win32 已由 Windows IL 方案接管（详见 sandboxWindowsIl.test）；其余冷门平台 unsupported", () => {
  const result = wrapCommandWithSandbox({
    policy: { enabled: true, mode: "workspace-write", workspaceRoot: WORKSPACE },
    platform: "freebsd",
    command: argvCommand(),
  });
  assert.equal(result.sandboxed, false);
  assert.equal(result.skippedReason, "unsupported-platform");
});

test("分发器：未启用快速路径与激活语义（必须显式 mode）", () => {
  const off = wrapCommandWithSandbox({
    policy: undefined,
    platform: "darwin",
    command: argvCommand(),
  });
  assert.equal(off.skippedReason, "disabled");

  const telemetryShape = wrapCommandWithSandbox({
    policy: { enabled: true },
    platform: "darwin",
    command: argvCommand(),
  });
  assert.equal(telemetryShape.sandboxed, false, "enabled 遥测位不得激活沙箱");
});

test("分发器：darwin → seatbelt（真机可达）", () => {
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC_PATH)) return;
  const result = wrapCommandWithSandbox({
    policy: { enabled: true, mode: "workspace-write", workspaceRoot: WORKSPACE },
    platform: "darwin",
    command: argvCommand(),
  });
  assert.equal(result.sandboxed, true);
  assert.equal(result.command.file, SANDBOX_EXEC_PATH);
});

// ---- Linux + bwrap 真集成（环境具备才跑；与 seatbelt 集成同套语料精神）----

const IS_LINUX_BWRAP = process.platform === "linux" && findBwrapPath() !== undefined;
const WS_DIR = IS_LINUX_BWRAP ? mkdtempSync("/tmp/sbx-ws-") : "";

function runBwrapSandboxed(command: string): { exitCode: number | null; stderr: string } {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const args = [
    ...buildWorkspaceWriteBwrapArgs({ workspaceRoot: WS_DIR }),
    "--",
    "/bin/bash",
    "-c",
    command,
  ];
  const run = spawnSync(findBwrapPath()!, args, { encoding: "utf8", timeout: 20_000 });
  return { exitCode: run.status, stderr: run.stderr ?? "" };
}

test("集成（linux+bwrap）：只读/界内写/出网全绿", { skip: !IS_LINUX_BWRAP }, () => {
  assert.equal(runBwrapSandboxed("echo hi && head -1 /etc/hosts >/dev/null && echo READ-OK").exitCode, 0);
  assert.equal(
    runBwrapSandboxed(`mkdir -p '${WS_DIR}/.git' && touch '${WS_DIR}/.git/index' && echo GIT-OK`).exitCode,
    0,
  );
  assert.equal(runBwrapSandboxed("mktemp /tmp/sbx-XXXXXX >/dev/null && echo TMP-OK").exitCode, 0);
});

test("集成（linux+bwrap）：越界写（家目录）被拒", { skip: !IS_LINUX_BWRAP }, () => {
  const outside = join(homedir(), `sbx-deny-${Date.now()}.txt`);
  const run = runBwrapSandboxed(`touch '${outside}'`);
  assert.notEqual(run.exitCode, 0);
  if (existsSync(outside)) rmSync(outside);
});

if (IS_LINUX_BWRAP) {
  test("清理 bwrap 集成临时目录", () => {
    rmSync(WS_DIR, { recursive: true, force: true });
  });
}

// 静态引用防止未用告警（BWRAP_CANDIDATE_PATHS 供外部探测复用）。
test("候选路径常量非空", () => {
  assert.ok(BWRAP_CANDIDATE_PATHS.length > 0);
});

test("清理 args 测试临时目录", () => {
  rmSync(WORKSPACE_DIR, { recursive: true, force: true });
});
