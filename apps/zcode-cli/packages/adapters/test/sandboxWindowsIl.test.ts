// E-S4(W) 测试：①脚本生成（降 IL C# 关键锚点/退出码透传/引号包裹/ComSpec shell 模式）；
// ②包装器形态（powershell -NoProfile…、labelArgs 降标指令、逃生与未启用路径）；
// ③win32 真集成（Low IL 下写 workspace 成功、写家目录被拒、只读可用、网络探测——
//   仅在 Windows 机器上自动激活，验证通过前 UI 保持禁用）。
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOW_IL_CSHARP_SETUP,
  buildLowIntegrityScript,
  buildWorkspaceLabelArgs,
  wrapCommandWithWindowsLowIL,
} from "../src/exec/sandbox/windows-il-exec.js";
import { wrapCommandWithSandbox } from "../src/exec/sandbox/wrap.js";

function command() {
  return { args: ["-c", "echo hi"], cwdDialect: "cmd" as const, file: "C:\\bin\\tool.exe", shell: false };
}

test("脚本：含降 IL 关键锚点（authority 0x10 / Low RID 0x1000 / class 25 / ADJUST_DEFAULT）", () => {
  assert.ok(LOW_IL_CSHARP_SETUP.includes("auth.b5 = 16"), "SECURITY_MANDATORY_LABEL_AUTHORITY");
  assert.ok(LOW_IL_CSHARP_SETUP.includes("0x1000"), "SECURITY_MANDATORY_LOW_RID");
  assert.ok(LOW_IL_CSHARP_SETUP.includes("token, 25"), "TokenIntegrityLevel=25");
  assert.ok(LOW_IL_CSHARP_SETUP.includes("0x0008"), "TOKEN_ADJUST_DEFAULT（降自身 IL 无需特权）");
});

test("脚本：退出码透传 + 目标命令逐项单引号包裹", () => {
  const script = buildLowIntegrityScript({ commandLine: `'C:\\bin\\tool.exe' '-c' 'echo it''s'` });
  assert.ok(script.includes("exit $LASTEXITCODE"), "退出码必须透传（CI 判定依赖）");
  assert.ok(script.includes("& 'C:\\bin\\tool.exe'"));
  assert.ok(script.includes("'echo it''s'"), "内嵌单引号必须翻倍转义");
  assert.ok(script.includes("DropToLow()"));
});

test("降标参数：workspace → Low IL 可继承", () => {
  assert.deepEqual(buildWorkspaceLabelArgs("C:\\ws\\app"), [
    "C:\\ws\\app",
    "/setintegritylevel",
    "(OI)(CI)L",
  ]);
});

test("包装器：powershell 形态 + labelArgs 透出；未启用/逃生/遥测形态不激活", () => {
  const wrapped = wrapCommandWithWindowsLowIL({
    policy: { enabled: true, mode: "workspace-write", workspaceRoot: "C:\\ws\\app" },
    command: command(),
    powershellPath: "C:\\pwsh.exe",
  });
  assert.equal(wrapped.sandboxed, true);
  assert.equal(wrapped.command.file, "C:\\pwsh.exe");
  assert.equal(wrapped.command.args[0], "-NoProfile");
  assert.equal(wrapped.command.args[4], "-Command");
  assert.deepEqual((wrapped as { labelArgs?: string[] }).labelArgs, [
    "C:\\ws\\app",
    "/setintegritylevel",
    "(OI)(CI)L",
  ]);

  // shell 模式（file=命令文本）经 ComSpec /d /s /c 执行。
  const shellWrapped = wrapCommandWithWindowsLowIL({
    policy: { enabled: true, mode: "workspace-write", workspaceRoot: "C:\\ws\\app" },
    command: { args: [], cwdDialect: "cmd" as const, file: "echo hi", shell: true },
    powershellPath: "C:\\pwsh.exe",
  });
  assert.ok(
    (shellWrapped.command.args[5] as string).includes("/d /s /c"),
    "shell 模式必须经 ComSpec 语义",
  );

  assert.equal(
    wrapCommandWithWindowsLowIL({ policy: undefined, command: command() }).skippedReason,
    "disabled",
  );
  assert.equal(
    wrapCommandWithWindowsLowIL({
      policy: { enabled: true, mode: "workspace-write", workspaceRoot: "C:\\ws" },
      command: command(),
      powershellPath: "C:\\pwsh.exe",
    }).sandboxed,
    true,
  );
  // 激活语义回归锚：历史遥测形态 {enabled:true, 无 mode} 不得激活（红线：默认 off）。
  assert.equal(
    wrapCommandWithWindowsLowIL({
      policy: { enabled: true },
      command: command(),
      powershellPath: "C:\\pwsh.exe",
    }).sandboxed,
    false,
  );
});

test("分发器：win32 → Windows IL 包装（其余冷门平台仍 unsupported-platform）", () => {
  const win = wrapCommandWithSandbox({
    policy: { enabled: true, mode: "workspace-write", workspaceRoot: "C:\\ws\\app" },
    platform: "win32",
    command: command(),
  });
  assert.equal(win.sandboxed, true, "win32 应走 Windows IL 包装");
  assert.ok((win.command.args[5] as string).includes("DropToLow"));

  const other = wrapCommandWithSandbox({
    policy: { enabled: true, mode: "workspace-write", workspaceRoot: "/ws" },
    platform: "freebsd",
    command: command(),
  });
  assert.equal(other.skippedReason, "unsupported-platform");
});

// ---- Windows 真集成（仅 win32 激活；这是放开 UI 门控的前置验收）----

const IS_WIN = process.platform === "win32";
const WS_DIR = IS_WIN ? mkdtempSync(join(tmpdir(), "sbx-ws-")) : "";

function runLowIL(commandLine: string, env: Record<string, string> = {}): { code: number | null; out: string } {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  // 与生产包装同构：先降标 workspace，再以 Low IL 运行命令。
  spawnSync("icacls.exe", buildWorkspaceLabelArgs(WS_DIR), { stdio: "ignore" });
  const script = buildLowIntegrityScript({
    commandLine: `'C:\\Windows\\System32\\cmd.exe' '/d' '/s' '/c' ${JSON.stringify(commandLine)}`,
  });
  const run = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", timeout: 30_000, env: { ...process.env, ...env } },
  );
  return { code: run.status, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

test("集成（win32）：全盘读可用、workspace 写成功、家目录写被拒、网络行为探测", { skip: !IS_WIN }, (t) => {
  const read = runLowIL("type C:\\Windows\\win.ini > NUL && echo READ-OK");
  assert.equal(read.code, 0, `Low IL 必须保持全盘读：${read.out}`);

  const inside = runLowIL(`echo x > "${WS_DIR}\\w.txt" && echo WS-OK`);
  assert.equal(inside.code, 0, `workspace（Low 标）必须可写：${inside.out}`);

  const outsidePath = join(homedir(), `sbx-deny-${Date.now()}.txt`);
  const outside = runLowIL(`echo x > "${outsidePath}"`);
  assert.notEqual(outside.code, 0, "家目录（Medium IL）写必须被内核拒绝");
  if (existsSync(outsidePath)) rmSync(outsidePath);

  // 网络行为取决于 Windows 防火墙对 Low IL 的默认策略——只记录，不设断言；
  // 结果决定文档口径（允许出网 / Windows 上等效断网），两种都可作为交付形态。
  const net = runLowIL(
    "curl.exe -s --max-time 8 -o NUL -w %{http_code} https://example.com",
  );
  t.diagnostic?.(`Low IL outbound http_code: ${net.out.trim() || "BLOCKED"} (exit ${net.code})`);
});

if (IS_WIN) {
  test("清理 Windows 集成临时目录", () => {
    rmSync(WS_DIR, { recursive: true, force: true });
  });
}
