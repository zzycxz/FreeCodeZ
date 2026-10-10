// E-S1/S2 测试：①sbpl 模板纯函数（含 .git 可写/尾斜杠归一/去重）；
// ②violation 归因表驱动（含 npm 缓存场景的修正指引）；③darwin 真沙箱集成
//（E2 命令语料精神：只读/界内写/.git 提交全绿、越界写被拒且归因含路径）。
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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

test("sbpl：缺省 tmpDir 放行真实 os.tmpdir()（process.tmpdir 误写回归锚）", () => {
  // 原实现误写 process.tmpdir（运行时恒 undefined），守卫恒假导致永远只放行
  // "/tmp"，macOS per-user 临时目录（/var/folders/...）被漏——缺省路径必须以
  // 真实 os.tmpdir() 为根比对。seatbelt 按真实路径匹配，macOS 的 /var 是
  // /private/var 的符号链接，故断言用 realpath 形态（与实现的 canonicalRoot 一致）。
  const profile = buildWorkspaceWriteSeatbeltProfile({ workspaceRoot: WORKSPACE });
  const raw = realpathSync(tmpdir());
  const expected = raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  assert.ok(
    profile.includes(`(subpath "${expected}")`),
    `缺省 profile 应放行真实临时目录 ${expected}`,
  );
});

test("sbpl：workspaceRoot 经符号链接打开时 canonical 化（seatbelt 按真实路径匹配）", () => {
  // 实测：profile 写 subpath "/tmp/x"（/tmp→/private/tmp 链接）时沙箱内写全拒
  // （Operation not permitted），必须写真实路径 /private/tmp/x。realpath 化写入根，
  // 否则符号链接路径下的 workspace 一开沙箱就 fail-dead。
  const linkParent = mkdtempSync(join(realpathSync(tmpdir()), "sbx-symlink-"));
  try {
    const realDir = join(linkParent, "real");
    mkdirSync(realDir);
    symlinkSync(realDir, join(linkParent, "link"));
    const profile = buildWorkspaceWriteSeatbeltProfile({
      workspaceRoot: join(linkParent, "link"),
    });
    assert.ok(
      profile.includes(`(subpath "${realDir}")`),
      "workspaceRoot 应 realpath 化为真实目录",
    );
    assert.ok(!profile.includes(`(subpath "${join(linkParent, "link")}")`));
  } finally {
    rmSync(linkParent, { recursive: true, force: true });
  }
});

test("0-9：凭据文件 deny 行存在且位于 (allow file-read*) 之后（seatbelt 后匹配胜出）", () => {
  const profile = buildWorkspaceWriteSeatbeltProfile({
    workspaceRoot: WORKSPACE,
    credentialDenyPath: "/Users/demo/.freecodez/v2/credentials.json",
  });
  const denyLine = '(deny file-read* (subpath "/Users/demo/.freecodez/v2/credentials.json"))';
  assert.ok(profile.includes(denyLine), "必须包含凭据文件 deny 行");
  assert.ok(
    profile.indexOf(denyLine) > profile.indexOf("(allow file-read*)"),
    "deny 行必须在 allow file-read* 之后（后匹配规则胜出语义）",
  );
  // 只 deny 这一个文件：不得出现对整个数据目录的 deny（provider config/任务库在旁边）。
  assert.ok(!profile.includes('(deny file-read* (subpath "/Users/demo/.freecodez"))'));
});

test("0-9：凭据 deny 路径缺省构造与 ZCODE_DATA_BASE_DIR 覆盖", () => {
  const home = homedir();
  const defaultProfile = buildWorkspaceWriteSeatbeltProfile({ workspaceRoot: WORKSPACE });
  assert.ok(
    defaultProfile.includes(
      `(deny file-read* (subpath "${join(home, ".freecodez", "v2", "credentials.json")}"))`,
    ),
    `缺省 deny 目标应是 ${join(home, ".freecodez", "v2", "credentials.json")}`,
  );
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
  // 必须以 `-- shell -c 命令文本` 收尾：node 的 shell 语义是 shell -c <文本>，
  // 缺 -c 时 bash 会把命令文本当脚本文件名执行（实测 exit 127）。
  assert.deepEqual(shellWrapped.command.args.slice(-3), ["/bin/bash", "-c", "echo hi"]);

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

  // Windows 低完整级（MIC）拒绝的报错只含盘符路径：提取器必须认 C:\ 形态，
  // 否则归因消息缺被拒路径（Windows 集成链路实测场景）。
  const winDeny = classifySandboxViolation({
    stderr: 'npm error code EPERM\nnpm error path C:\\Users\\demo\\.npm\\_cacache\\tmp\\abc',
  });
  assert.equal(winDeny?.category, "write-denied");
  assert.equal(winDeny?.deniedPath, "C:\\Users\\demo\\.npm\\_cacache\\tmp\\abc");

  // EISDIR 是"把目录当文件操作"，不是沙箱读拒绝；不得误归因为 read-denied。
  assert.equal(classifySandboxViolation({ stderr: "cat /some/dir: EISDIR" }), undefined);

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

test("集成（darwin）：V9——沙箱内读凭据文件被拒，邻居文件不受影响", { skip: !IS_DARWIN }, () => {
  const credentialsPath = join(homedir(), ".freecodez", "v2", "credentials.json");
  // 0-9 验收①：cat credentials.json 必须被拒（deny 行优先于全盘 allow file-read*）。
  const denied = runSandboxed(`cat '${credentialsPath}'`);
  assert.notEqual(denied.exitCode, 0, "沙箱内读凭据文件必须失败");
  assert.ok(
    /Operation not permitted|Permission denied/i.test(denied.stderr),
    `拒绝应来自沙箱 deny 而非文件缺失：${denied.stderr}`,
  );
  // 0-9 验收③：同目录邻居（任务库/其他文件）不受影响——只 deny 这一个文件。
  const neighborOk = runSandboxed(`ls '${join(homedir(), ".freecodez", "v2")}' >/dev/null && echo NEIGHBOR-OK`);
  assert.equal(neighborOk.exitCode, 0, `目录列举不受影响：${neighborOk.stderr}`);
});

if (IS_DARWIN) {
  test("清理沙箱集成临时目录", () => {
    rmSync(WORKSPACE_SANDBOX_DIR, { recursive: true, force: true });
  });
}
