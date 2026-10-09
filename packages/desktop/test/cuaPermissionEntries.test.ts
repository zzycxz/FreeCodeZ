// R21c 权限条目自动化（ensureCuaPermissionEntries）测试：
// ① 主应用录屏 + AX 自注册 + helper 一次性请求拉起三件齐全；
// ② 每进程只跑一次（幂等），非 darwin 早退；
// ③ helper 拉起失败只记日志、结果如实带回（不阻断调用方）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHelperPermissionRequestOpenArgs,
  ensureCuaPermissionEntries,
  resetCuaPermissionEntriesForTests,
} from "../src/main/cuaPermissionEntries.js";

test("R21c：主应用录屏+AX 自注册 + helper 一次性请求拉起；幂等每进程一次", async () => {
  resetCuaPermissionEntriesForTests();
  const calls: string[] = [];
  const result = await ensureCuaPermissionEntries({
    platform: "darwin",
    probeMainScreenCapture: () => {
      calls.push("probe-screen");
      return false;
    },
    requestMainScreenCapture: () => {
      calls.push("request-screen");
      return { granted: true };
    },
    probeMainAccessibility: () => {
      calls.push("probe-ax");
      return false;
    },
    requestMainAccessibility: () => {
      calls.push("request-ax");
      return true;
    },
    ensureHelperInstalled: async () => {
      calls.push("install");
      return "/tmp/fake/FreeCodeZ Computer Use.app";
    },
    spawnHelperRequest: async (appPath) => {
      calls.push(`spawn:${appPath}`);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.helperSpawned, true);
  assert.ok(calls.includes("request-screen"), "主应用录屏未授权即请求");
  assert.ok(calls.includes("request-ax"), "主应用 AX 未信任即请求");
  assert.ok(calls.includes("install"), "helper 先安装（验签）");
  assert.ok(
    calls.some((call) => call.startsWith("spawn:")),
    "helper 一次性请求模式拉起",
  );
  // 录屏自注册内嵌（共享件）：probe 未注入时走真实现——此处只断言不抛。

  const second = await ensureCuaPermissionEntries({
    platform: "darwin",
    ensureHelperInstalled: async () => {
      throw new Error("must not be called twice");
    },
    spawnHelperRequest: async () => {
      throw new Error("must not be called twice");
    },
  });
  assert.equal(second.attempted, false);
  assert.equal(second.reason, "already_attempted", "每进程只跑一次");
});

test("R21c：一次性请求走 LaunchServices 形态（open -n -a，helper 自身成为 TCC 责任主体）", () => {
  const args = buildHelperPermissionRequestOpenArgs("/tmp/fake/FreeCodeZ Computer Use.app");
  assert.deepEqual(args, [
    "-n",
    "-a",
    "/tmp/fake/FreeCodeZ Computer Use.app",
    "--args",
    "/tmp/fake/FreeCodeZ Computer Use.app/Contents/Resources/dist/helper-main.mjs",
    "--request-permissions",
  ]);
});

test("R21c：非 darwin 早退；helper 拉起失败不抛、reason 如实", async () => {
  resetCuaPermissionEntriesForTests();
  const notDarwin = await ensureCuaPermissionEntries({ platform: "win32" });
  assert.equal(notDarwin.attempted, false);
  assert.equal(notDarwin.reason, "not_darwin");

  resetCuaPermissionEntriesForTests();
  const warnings: string[] = [];
  const failed = await ensureCuaPermissionEntries({
    platform: "darwin",
    probeMainScreenCapture: () => true,
    requestMainScreenCapture: () => {
      throw new Error("must not request when granted");
    },
    probeMainAccessibility: () => true,
    requestMainAccessibility: () => {
      throw new Error("must not request when trusted");
    },
    ensureHelperInstalled: async () => {
      throw new Error("install failed");
    },
    logger: { warn: (message: unknown) => warnings.push(String(message)) },
  });
  assert.equal(failed.ok, true, "失败不抛、ok 仍真（尽力而为）");
  assert.equal(failed.helperSpawned, false);
  assert.match(failed.reason ?? "", /install failed/);
  assert.ok(warnings.some((message) => message.includes("helper permission request failed")));
});
