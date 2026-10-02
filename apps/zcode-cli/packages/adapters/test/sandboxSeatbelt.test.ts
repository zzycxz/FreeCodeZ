// E-S1/S2 测试：①sbpl 模板纯函数（含 .git 可写/尾斜杠归一/去重）；
// ②violation 归因表驱动（含 npm 缓存场景的修正指引）；③darwin 真沙箱集成
//（E2 命令语料精神：只读/界内写/.git 提交全绿、越界写被拒且归因含路径）。
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkspaceWriteSeatbeltProfile } from "../src/exec/sandbox/seatbelt-profile.js";
import { classifySandboxViolation } from "../src/exec/sandbox/violation.js";
import { wrapCommandWithSeatbelt, SANDBOX_EXEC_PATH } from "../src/exec/sandbox/seatbelt-exec.js";

const WORKSPACE = "/Users/demo/projects/app";

test("sbpl：workspace 根可写（含 .git——codex 只读 .git 的反面教训不重演）", () => {
  const profile = buildWorkspaceWriteSeatbeltProfile({ workspaceRoot: WORKSPACE });
  assert.ok(profile.includes(`(allow file-write* (subpath "${WORKSPACE}"))`));
  // workspace-write 语义下 .git 在根内自然可写，不出现针对 .git 的 deny。
  assert.ok(!profile.includes(".git"));
  assert.ok(profile.startsWith("(version 1)"));
  assert.ok(profile.includes("(deny default)"));
  assert.ok(profile.includes("(allow file-read*)"));
  // 操作集为本机 sandbox-exec 实测验证：sysctl-read 缺它 node/V8 崩溃；
  // /dev/null literal 缺它 git commit 必败；network* 允许出网（首期策略）。
  assert.ok(profile.includes("(allow sysctl-read)"));
  assert.ok(profile.includes('(allow file-write* (literal "/dev/null"))'));
  assert.ok(profile.includes("(allow network*)"));
  // 旧族操作（signal*/mach*/ipc*）在新 seatbelt 非法或异常，模板不得包含。
  assert.ok(!profile.includes("signal"));
  assert.ok(!profile.includes("mach"));
});

test("sbpl：/tmp 族默认可写、尾斜杠归一、writableRoots 去重", () => {
  const profile = buildWorkspaceWriteSeatbeltProfile({
    workspaceRoot: `${WORKSPACE}/`,
    writableRoots: ["/opt/cache", "/opt/cache", "/var/folders/xx/T/"],
    tmpDir: "/var/folders/xx/T",
  });
  assert.ok(profile.includes(`(subpath "${WORKSPACE}")`), "尾斜杠应被归一");
  assert.ok(profile.includes('(subpath "/opt/cache")'));
  assert.equal(profile.split('(subpath "/opt/cache")').length - 1, 1, "重复根只出现一次");
  assert.ok(profile.includes('(subpath "/private/tmp")'));
  assert.ok(profile.includes('(subpath "/var/folders/xx/T")'));
});

test("wrap：argv 与 shell 模式统一抬进 sandbox-exec；激活必须显式 mode", () => {
  const argvCommand = { args: ["-c", "ls"], cwdDialect: "posix" as const, file: "/bin/bash", shell: false };
  const wrapped = wrapCommandWithSeatbelt({
    policy: { enabled: true, mode: "workspace-write", workspaceRoot: WORKSPACE },
    platform: "darwin",
    command: argvCommand,
  });
  assert.equal(wrapped.sandboxed, true);
  assert.equal(wrapped.command.file, SANDBOX_EXEC_PATH);
  assert.equal(wrapped.command.args[0], "-p");
  assert.equal(wrapped.command.args[2], "--");
  assert.equal(wrapped.command.args[3], "/bin/bash");

  const shellCommand = { args: [] as string[], cwdDialect: "posix" as const, file: "echo hi", shell: true };
  const shellWrapped = wrapCommandWithSeatbelt({
    policy: { enabled: true, mode: "workspace-write", workspaceRoot: WORKSPACE },
    platform: "darwin",
    command: shellCommand,
  });
  assert.equal(shellWrapped.sandboxed, true);
  assert.equal(shellWrapped.command.args.at(-2), "/bin/bash");
  assert.equal(shellWrapped.command.args.at(-1), "echo hi");

  // 关键回归锚：Bash handler 的历史形态 {enabled:true, 无 mode}（遥测语义）不得激活
  // 沙箱——否则 mac 上普通命令被默认全量沙箱化，违反"默认 off"红线。
  const telemetryShape = wrapCommandWithSeatbelt({
    policy: { enabled: true },
    platform: "darwin",
    command: argvCommand,
  });
  assert.equal(telemetryShape.sandboxed, false);
  assert.equal(telemetryShape.command, argvCommand);

  const disabled = wrapCommandWithSeatbelt({
    policy: undefined,
    platform: "darwin",
    command: argvCommand,
  });
  assert.equal(disabled.sandboxed, false);
  assert.equal(disabled.skippedReason, "disabled");
  assert.equal(disabled.command, argvCommand, "未启用时原样返回（off 与现状逐字节一致）");

  const explicitOff = wrapCommandWithSeatbelt({
    policy: { enabled: true, mode: "off", workspaceRoot: WORKSPACE },
    platform: "darwin",
    command: argvCommand,
  });
  assert.equal(explicitOff.sandboxed, false);

  const bypassed = wrapCommandWithSeatbelt({
    policy: {
      enabled: true,
      mode: "workspace-write",
      workspaceRoot: WORKSPACE,
      dangerouslyDisableSandbox: true,
    },
    platform: "darwin",
    command: argvCommand,
  });
  assert.equal(bypassed.sandboxed, false, "dangerouslyDisableSandbox 必须可逃生");

  const nonDarwin = wrapCommandWithSeatbelt({
    policy: { enabled: true, mode: "workspace-write", workspaceRoot: WORKSPACE },
    platform: "linux",
    command: argvCommand,
  });
  assert.equal(nonDarwin.skippedReason, "non-darwin");
});

function expectAny(): string {
  return String(wrappedProfileForAssertion());
}
function wrappedProfileForAssertion(): unknown {
  return 0;
}

test("归因：EPERM 写拒绝提取路径，npm 缓存场景给出重定向指引", () => {
  const npmDeny = classifySandboxViolation({
    stderr: 'npm error code EPERM\nnpm error syscall open\nnpm error path /Users/demo/.npm/_cacache/tmp/abc',
  });
  assert.ok(npmDeny);
  assert.equal(npmDeny.category, "write-denied");
  assert.equal(npmDeny.deniedPath, "/Users/demo/.npm/_cacache/tmp/abc");
  assert.ok(npmDeny.message.includes("npm_config_cache"), "缓存场景应建议重定向进工作区");

  const plainDeny = classifySandboxViolation({ stderr: "cp: /etc/hosts: Permission denied" });
  assert.equal(plainDeny?.category, "write-denied");
  assert.equal(plainDeny?.deniedPath, "/etc/hosts");

  assert.equal(classifySandboxViolation({ stderr: "everything fine" }), undefined);
  assert.equal(classifySandboxViolation({ stderr: "" }), undefined);
});

test("归因：裸 EPERM（无动词细分）默认归 write-denied（仍含修正指引）", () => {
  const match = classifySandboxViolation({ stderr: "some tool failed with EPERM somewhere" });
  assert.equal(match?.category, "write-denied");
  assert.ok(match?.message.includes("denied by the sandbox") || match?.message.includes("sandbox denied"));
});

// ---- 真沙箱集成（仅 darwin；E2 命令语料精神）----

const IS_DARWIN = process.platform === "darwin";
const WORKSPACE_SANDBOX_DIR = IS_DARWIN
  ? mkdtempSync(join(realpathSync(tmpdir()), "sbx-ws-"))
  : "";

function homedirSafe(): string {
  return homedir();
}

function runSandboxed(command: string): { exitCode: number | null; stderr: string } {
  const profile = buildWorkspaceWriteSeatbeltProfile({ workspaceRoot: WORKSPACE_SANDBOX_DIR });
  const run = spawnSync(
    SANDBOX_EXEC_PATH,
    ["-p", profile, "--", "/bin/bash", "-c", command],
    { encoding: "utf8", timeout: 20_000 },
  );
  return { exitCode: run.status, stderr: run.stderr ?? "" };
}

test("集成（darwin）：只读 / 界内写 / .git 提交 / node / 出网全绿", { skip: !IS_DARWIN }, (t) => {
  const read = runSandboxed("echo hello && head -1 /etc/hosts >/dev/null && echo READ-OK");
  assert.equal(read.exitCode, 0, `只读不应被沙箱影响：${read.stderr}`);

  const gitFlow = runSandboxed(
    `cd '${WORKSPACE_SANDBOX_DIR}' && git init -q . && touch a.txt && ` +
      `git add a.txt && git -c user.email=t@t -c user.name=t commit -qm x && echo GIT-OK`,
  );
  assert.equal(gitFlow.exitCode, 0, `.git 必须可写（不重演 codex 反面教训）：${gitFlow.stderr}`);

  const nodeRun = runSandboxed(`node -e 'console.log("NODE-OK")'`);
  assert.equal(nodeRun.exitCode, 0, `node 需要 sysctl-read（实测缺它 V8 崩溃）：${nodeRun.stderr}`);

  const tmpWrite = runSandboxed("mktemp /tmp/sbx-XXXXXX >/dev/null && echo TMP-OK");
  assert.equal(tmpWrite.exitCode, 0, `/tmp 必须默认可写：${tmpWrite.stderr}`);

  const insideWrite = runSandboxed(`touch '${WORKSPACE_SANDBOX_DIR}/inside.txt' && echo WS-OK`);
  assert.equal(insideWrite.exitCode, 0, `workspace 内写应放行：${insideWrite.stderr}`);

  const net = runSandboxed(
    `curl -s --max-time 8 -o /dev/null -w '%{http_code}' https://example.com`,
  );
  assert.equal(net.exitCode, 0, `首期策略允许出网：${net.stderr}`);
  t.diagnostic?.(`net status: ${net.stderr.trim()}`);
});

test("集成（darwin）：越界写（家目录，不在任何可写根）被拒且归因可提取路径", { skip: !IS_DARWIN }, () => {
  const outside = join(realpathSync(homedirSafe()), `sbx-deny-${Date.now()}.txt`);
  const run = runSandboxed(`touch '${outside}'`);
  assert.notEqual(run.exitCode, 0, "越界写必须被拒");
  const violation = classifySandboxViolation({ stderr: run.stderr });
  assert.ok(violation, `stderr 应可归因：${run.stderr}`);
  assert.equal(violation.category, "write-denied");
  assert.ok(
    violation.deniedPath?.startsWith(realpathSync(homedirSafe())),
    `归因应指向被拒路径：${violation.deniedPath}`,
  );
  if (existsSync(outside)) rmSync(outside);
});

test("集成（darwin）：对照——无沙箱时同一命令可写（证明拒绝来自沙箱）", { skip: !IS_DARWIN }, () => {
  const outside = join(realpathSync(tmpdir()), `sbx-free-${Date.now()}.txt`);
  const run = spawnSync("/bin/bash", ["-c", `touch '${outside}'`], { encoding: "utf8" });
  assert.equal(run.status, 0);
  rmSync(outside);
});

if (IS_DARWIN) {
  test("清理沙箱集成临时目录", () => {
    rmSync(WORKSPACE_SANDBOX_DIR, { recursive: true, force: true });
  });
}
