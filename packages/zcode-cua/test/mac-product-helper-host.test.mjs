// R19（mac Helper 自研产线）：宿主生命周期真实现测试。
// 用临时目录伪造 .app 形状（MacOS 可执行=node、Resources/dist/helper-main.mjs=真实入口源码），
// fake installer 跳过安装/验签，其余链路（spawn argv 合同→健康 pid 对账→权限探测→stop）全真。
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { callBrokerMethod } from "../broker.js";
import { HELPER_BUNDLE_ID, HELPER_DISPLAY_NAME } from "../broker-helper-constants.js";
import { createMacProductHelperHost } from "../macos/product-helper-host.js";

const IS_DARWIN = process.platform === "darwin";
const helperEntry = fileURLToPath(new URL("../macos/helper-main.js", import.meta.url));

function stageFakeHelperApp(root) {
  const appDir = join(root, "FreeCodeZ Computer Use.app");
  const macosDir = join(appDir, "Contents", "MacOS");
  const distDir = join(appDir, "Contents", "Resources", "dist");
  mkdirSync(macosDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  // 可执行名=束名去 .app（宿主按此推导）；真 Mach-O 用 node 本尊（symlink 即可执行）。
  // 入口同样 symlink 到真实源码——helper-main 的直跑判定按双方 realpath 比较，symlink 可用。
  symlinkSync(process.execPath, join(macosDir, "FreeCodeZ Computer Use"));
  symlinkSync(helperEntry, join(distDir, "helper-main.mjs"));
  return appDir;
}

test(
  "宿主生命周期：start→handle/健康对账→权限探测→stop",
  { skip: !IS_DARWIN ? "mac Helper 宿主仅 darwin" : false },
  async () => {
    const workDir = mkdtempSync(join(tmpdir(), "cua-helper-host-test-"));
    // XDG_RUNTIME_DIR 把 socket 铸造重定向到临时目录，避免撞真实 /tmp/freecodez-cua-<uid>。
    const env = { XDG_RUNTIME_DIR: join(workDir, "xdg") };
    const appDir = stageFakeHelperApp(workDir);
    const installer = {
      async ensureInstalled() {
        return appDir;
      },
      async verifyInstalled() {},
    };
    const host = createMacProductHelperHost({
      env,
      helperInstaller: installer,
      buildHelperOpenArgs: (spec, launcherPid) => [
        "--socket",
        spec.socketPath,
        "--parent-pid",
        String(launcherPid),
      ],
      healthTimeoutMs: 15_000,
    });
    assert.equal(host.running, false);
    assert.equal(host.socketPath, null);
    try {
      const handle = await host.start();
      assert.ok(handle.socketPath.startsWith(join(workDir, "xdg")), handle.socketPath);
      assert.equal(typeof handle.pid, "number");
      assert.equal(handle.bundleId, HELPER_BUNDLE_ID);
      assert.equal(host.running, true);
      assert.equal(host.socketPath, handle.socketPath);
      assert.ok(host.pluginAuthority);
      // start 幂等：已运行时直接返回既有 handle（不做健康探测）。
      const again = await host.start();
      assert.equal(again.socketPath, handle.socketPath);
      // 健康对账：broker_info pid 与 spawn 子进程一致。
      const health = await host.checkHealth(5_000);
      assert.equal(health.pid, handle.pid);
      assert.equal(health.bundleId, HELPER_BUNDLE_ID);
      // 权限探测面（stable socket 上的 permission_status/screen_capture_status 映射）。
      const status = await host.queryPermissionStatus();
      assert.equal(status.grant_owner, HELPER_BUNDLE_ID);
      assert.equal(status.owner.display_name, HELPER_DISPLAY_NAME);
      assert.ok(["granted", "denied", "unknown"].includes(status.accessibility));
      assert.ok(["granted", "denied", "unknown"].includes(status.screen_recording));
      const probe = await host.queryScreenCaptureProbe();
      assert.equal(typeof probe.ok, "boolean");
      assert.ok(typeof probe.reason === "string");
      const preflight = await host.queryScreenRecordingPreflight();
      assert.ok(["granted", "denied", "unknown"].includes(preflight));
      // broker 一次性客户端仍可直连（工具连接语义）。
      const info = await callBrokerMethod({
        socketPath: handle.socketPath,
        method: "broker_info",
        params: {},
        timeoutMs: 5_000,
      });
      assert.equal(info.pid, handle.pid);
    } finally {
      await host.stop();
      assert.equal(host.running, false);
      assert.equal(host.socketPath, null);
      rmSync(workDir, { recursive: true, force: true });
    }
  },
);

test(
  "宿主失败路径：helper 启动即死 → start 拒绝且不留 transport",
  { skip: !IS_DARWIN ? "mac Helper 宿主仅 darwin" : false },
  async () => {
    const workDir = mkdtempSync(join(tmpdir(), "cua-helper-host-fail-test-"));
    const env = { XDG_RUNTIME_DIR: join(workDir, "xdg") };
    const appDir = stageFakeHelperApp(workDir);
    const installer = {
      async ensureInstalled() {
        return appDir;
      },
      async verifyInstalled() {},
    };
    const host = createMacProductHelperHost({
      env,
      helperInstaller: installer,
      buildHelperOpenArgs: () => [],
      // 健康探针恒空 → 触发 pid 失配拒绝路径。
      healthProbe: async () => ({ bundleId: null, pid: null }),
      healthTimeoutMs: 500,
    });
    try {
      await assert.rejects(() => host.start(), (error) => error.code === "helper_unavailable");
      assert.equal(host.running, false);
      assert.equal(host.socketPath, null);
    } finally {
      await host.stop();
      rmSync(workDir, { recursive: true, force: true });
    }
  },
);

test(
  "多窗口收养：稳定 socket 上已有健康 Helper → start 收养同 pid、不重复 spawn、stop 不杀它",
  { skip: !IS_DARWIN ? "mac Helper 宿主仅 darwin" : false },
  async () => {
    // 注意 mkdtemp 前缀长度：macOS sun_path 上限 104 字节，tmpdir+前缀+/xdg/zcode-cua/broker.sock
    // 越线会 listen EINVAL（既知坑，本测试首次即踩：长前缀 108 字节）。
    const workDir = mkdtempSync(join(tmpdir(), "cua-adopt-"));
    const env = { XDG_RUNTIME_DIR: join(workDir, "xdg") };
    const appDir = stageFakeHelperApp(workDir);
    const installer = {
      async ensureInstalled() {
        return appDir;
      },
      async verifyInstalled() {},
    };
    // 先用真实 buildHelperOpenArgs 直接拉一个「别家的」helper 占住稳定 socket。
    const { buildHelperOpenArgs } = await import("../broker-server.js");
    const socketPath = join(workDir, "xdg", "zcode-cua", "broker.sock");
    const existing = spawn(process.execPath, [join(appDir, "Contents", "Resources", "dist", "helper-main.mjs"), ...buildHelperOpenArgs({ socketPath }, process.pid)], { stdio: ["ignore", "ignore", "ignore"] });
    const host = createMacProductHelperHost({ env, helperInstaller: installer, buildHelperOpenArgs, healthTimeoutMs: 15_000 });
    try {
      const deadline = Date.now() + 15_000;
      while (!host.socketPath) {
        if (Date.now() > deadline) assert.fail("收养超时：稳定 socket 未出现 helper");
        try {
          const handle = await host.start();
          assert.equal(handle.pid, existing.pid, "应收养既有 helper 的 pid");
          break;
        } catch (error) {
          if (process.env.CUA_ADOPT_DEBUG) {
            console.error("[adopt-retry]", error?.code, error?.message);
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      assert.equal(host.running, true);
      // 收养形态 start 幂等（直接返回既有 handle，不重复探测）。
      const again = await host.start();
      assert.equal(again.pid, existing.pid);
      await host.stop();
      assert.equal(host.running, false);
      assert.equal(existing.exitCode, null, "收养对象的宿主 stop 不得杀非自有 helper");
    } finally {
      existing.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          existing.kill("SIGKILL");
          resolve();
        }, 5_000);
        existing.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      rmSync(workDir, { recursive: true, force: true });
    }
  },
);
