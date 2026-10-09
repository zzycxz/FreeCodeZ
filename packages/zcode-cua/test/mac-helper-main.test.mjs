// R19（mac Helper 自研产线）：helper-main 进程入口测试。
// 纯函数段（argv 解析/controller 门）跨平台常跑；spawn 端到端段仅 darwin 且 koffi 可解析时跑
// （koffi 缺席=生产语义 fail-closed 退出，不是测试失败面）。
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { callBrokerMethod } from "../broker.js";
import { HELPER_BUNDLE_ID } from "../broker-helper-constants.js";
import { createControllerClaim, parseHelperArgs, runHelperMain } from "../macos/helper-main.js";
import { buildHelperOpenArgs } from "../broker-server.js";

const IS_DARWIN = process.platform === "darwin";
const helperEntry = fileURLToPath(new URL("../macos/helper-main.js", import.meta.url));
const requireFromHelper = createRequire(helperEntry);
let KOFFI_AVAILABLE = false;
if (IS_DARWIN) {
  try {
    requireFromHelper("koffi");
    KOFFI_AVAILABLE = true;
  } catch {
    KOFFI_AVAILABLE = false;
  }
}
const SPAWNABLE = IS_DARWIN && KOFFI_AVAILABLE;

test("parseHelperArgs：flag 值 / flag=值 / 忽略无关参数 / parent-pid 可选", () => {
  const parsed = parseHelperArgs([
    "/path/to/helper-main.mjs",
    "--socket",
    "/tmp/x/broker.sock",
    "--parent-pid",
    "4242",
    "--exit-log=/tmp/x/logs",
  ]);
  assert.equal(parsed.socketPath, "/tmp/x/broker.sock");
  assert.equal(parsed.parentPid, 4242);
  assert.equal(parsed.exitLogTarget, "/tmp/x/logs");
  assert.deepEqual(parseHelperArgs(["--socket"]), {
    socketPath: undefined,
    parentPid: undefined,
    exitLogTarget: undefined,
    requestPermissions: false,
  });
  assert.equal(parseHelperArgs(["--socket", "--parent-pid", "1"]).socketPath, undefined);
  // standalone 形态（设置页 open 拉起）：只有 socket，无 parent-pid。
  assert.deepEqual(parseHelperArgs(["--socket", "/tmp/s.sock"]), {
    socketPath: "/tmp/s.sock",
    parentPid: undefined,
    exitLogTarget: undefined,
    requestPermissions: false,
  });
  // R21c 一次性权限请求模式：布尔旗标，任意形态都开。
  assert.equal(parseHelperArgs(["--request-permissions"]).requestPermissions, true);
  assert.equal(parseHelperArgs(["--request-permissions=1"]).requestPermissions, true);
  assert.equal(
    parseHelperArgs(["--socket", "/tmp/s.sock", "--request-permissions"]).requestPermissions,
    true,
  );
});

test("runHelperMain --request-permissions：一次性请求模式（R21c）双请求即发、双授即退 exit 0", async () => {
  const calls = [];
  const diagnostics = [];
  let exitCode;
  await runHelperMain({
    argv: ["helper-main.mjs", "--request-permissions"],
    exit: (code) => {
      exitCode = code;
    },
    diagnostic: (text) => diagnostics.push(text),
    permissionRequests: {
      requestAccessibilityAccess: () => {
        calls.push("accessibility");
        return { granted: true, koffiAvailable: true };
      },
      requestScreenCaptureAccess: () => {
        calls.push("screen");
        return { granted: true, koffiAvailable: true };
      },
      probePermissions: () => ({ accessibility: true, screenCapture: true, koffiAvailable: true }),
      sleep: async () => {},
    },
  });
  assert.deepEqual(calls, ["accessibility", "screen"], "AX 与录屏都发起请求");
  assert.equal(exitCode, 0);
  assert.ok(diagnostics.some((text) => text.includes("request-permissions")), "诊断行带模式名");
});

test("runHelperMain --request-permissions：未授权驻留有界（60 次），超时照退 exit 0", async () => {
  let sleeps = 0;
  let exitCode;
  await runHelperMain({
    argv: ["helper-main.mjs", "--request-permissions"],
    exit: (code) => {
      exitCode = code;
    },
    diagnostic: () => {},
    now: () => 0,
    permissionRequests: {
      requestAccessibilityAccess: () => ({ granted: false, koffiAvailable: true }),
      requestScreenCaptureAccess: () => ({ granted: false, koffiAvailable: true }),
      probePermissions: () => ({ accessibility: false, screenCapture: false, koffiAvailable: true }),
      sleep: async () => {
        sleeps += 1;
      },
    },
  });
  assert.equal(sleeps, 60, "驻留循环有界，不空转死等");
  assert.equal(exitCode, 0);
});

test("buildHelperOpenArgs：直接 spawn 纯 argv 形态与 LaunchServices open 形态（R19 复查补全）", () => {
  assert.deepEqual(
    buildHelperOpenArgs({ socketPath: "/tmp/s.sock" }, 123),
    ["--socket", "/tmp/s.sock", "--parent-pid", "123"],
  );
  // open 形态：appPath 在场 → -a <app> --args <entry> 前缀（entry 必带：可执行体=node 底座，
  // 缺 entry 时 node 把 --socket 当自身选项即退，2026-10-08 真机实证）。
  assert.deepEqual(
    buildHelperOpenArgs({ appPath: "/Applications/X.app", socketPath: "/tmp/s.sock", exitLogPath: "/tmp/s.exit.log" }),
    [
      "-a",
      "/Applications/X.app",
      "--args",
      "/Applications/X.app/Contents/Resources/dist/helper-main.mjs",
      "--socket",
      "/tmp/s.sock",
      "--exit-log",
      "/tmp/s.exit.log",
    ],
  );
  assert.deepEqual(
    buildHelperOpenArgs({ appPath: "/Applications/X.app", socketPath: "/tmp/s.sock", exitLogDir: "/tmp/logs" }, 9),
    [
      "-a",
      "/Applications/X.app",
      "--args",
      "/Applications/X.app/Contents/Resources/dist/helper-main.mjs",
      "--socket",
      "/tmp/s.sock",
      "--parent-pid",
      "9",
      "--exit-log",
      "/tmp/logs",
    ],
  );
});

test("createControllerClaim：无主接管 / 活跃冲突 CONTROLLER_BUSY / TTL 过期可再接管 / markStopped", () => {
  let now = 1_000;
  const claim = createControllerClaim({ ttlMs: 90_000, now: () => now });
  claim.ensureOwner("conn-a");
  assert.equal(claim.snapshot().controller, "conn-a");
  assert.throws(() => claim.ensureOwner("conn-b"), (error) => error.code === "CONTROLLER_BUSY");
  // 活跃刷新：a 再动一下，b 仍被拒。
  now += 1_000;
  claim.ensureOwner("conn-a");
  assert.throws(() => claim.ensureOwner("conn-b"), (error) => error.code === "CONTROLLER_BUSY");
  // TTL 过期：b 可接管。
  now += 91_000;
  claim.ensureOwner("conn-b");
  assert.equal(claim.snapshot().controller, "conn-b");
  // 连接关闭释放：b 释放后 a 直接接管。
  claim.release("conn-b");
  claim.ensureOwner("conn-a");
  // 停止后：任何接管都 CONTROL_STOPPED，快照标记 stopped。
  claim.markStopped();
  assert.equal(claim.snapshot().stopped, true);
  assert.throws(() => claim.ensureOwner("conn-a"), (error) => error.code === "CONTROL_STOPPED");
});

/** 持久连接客户端（controller 门挂连接归属，一次性 callBrokerMethod 测不了冲突面）。 */
function connectPersistentBroker(socketPath) {
  const socket = connect(socketPath);
  socket.setEncoding("utf8");
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = pending.get(parsed?.id);
      if (!entry) continue;
      pending.delete(parsed.id);
      if (parsed.ok === true) entry.resolve(parsed.result);
      else {
        const error = new Error(parsed.error?.message ?? "broker error");
        error.code = parsed.error?.code;
        entry.reject(error);
      }
    }
  });
  const ready = new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  return {
    async call(method, params) {
      await ready;
      const id = nextId;
      nextId += 1;
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.write(`${JSON.stringify({ id, method, params: params ?? {} })}\n`);
      return await response;
    },
    close() {
      socket.destroy();
    },
  };
}

test(
  "helper-main 端到端：spawn→健康对账→controller 门→R5 停止语义→退出清理",
  { skip: !SPAWNABLE ? "需要 darwin + koffi 可解析" : false },
  async () => {
    const workDir = mkdtempSync(join(tmpdir(), "cua-helper-main-test-"));
    const socketPath = join(workDir, "zcode-cua", "broker.sock");
    const exitLogDir = join(workDir, "logs");
    const child = spawn(
      process.execPath,
      [helperEntry, "--socket", socketPath, "--parent-pid", String(process.pid), "--exit-log", exitLogDir],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    try {
      const deadline = Date.now() + 15_000;
      while (!existsSync(socketPath)) {
        if (Date.now() > deadline) assert.fail(`helper socket 未出现：${stderr}`);
        if (child.exitCode !== null) assert.fail(`helper 提前退出 code=${child.exitCode}：${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // 一次性客户端（隐式 authenticate）+ id 回显 + 健康对账字段。
      const info = await callBrokerMethod({ socketPath, method: "broker_info", params: {}, timeoutMs: 5_000 });
      assert.equal(info.pid, child.pid);
      assert.equal(info.authorization_subject, HELPER_BUNDLE_ID);
      const ping = await callBrokerMethod({ socketPath, method: "ping", params: {}, timeoutMs: 5_000 });
      assert.equal(ping.serverApiVersion, 2);
      const permission = await callBrokerMethod({
        socketPath,
        method: "permission_status",
        params: {},
        timeoutMs: 5_000,
      });
      assert.equal(permission.ok, true);
      // 双形状（R19 复查补全）：宿主消费布尔（accessibility_trusted/screen_capture），
      // 设置页稳定 socket 直查消费报告枚举（accessibility/screen_recording）+属主字段。
      assert.equal(typeof permission.accessibility_trusted, "boolean");
      assert.equal(typeof permission.screen_capture, "boolean");
      assert.ok(["granted", "denied"].includes(permission.accessibility));
      assert.ok(["granted", "denied"].includes(permission.screen_recording));
      assert.equal(permission.grant_owner, HELPER_BUNDLE_ID);
      assert.equal(permission.owner.display_name, "FreeCodeZ Computer Use");
      assert.equal(permission.accessibility_probe.ok, permission.accessibility === "granted");

      // controller 门（持久连接）：A 接管 → B 冲突 CONTROLLER_BUSY → A 停止 → 观测 CONTROL_STOPPED、
      // request_access 豁免。
      const clientA = connectPersistentBroker(socketPath);
      await clientA.call("authenticate", { clientApiVersion: 2 });
      const takeover = await clientA.call("controller_takeover");
      assert.equal(takeover.ok, true);
      const clientB = connectPersistentBroker(socketPath);
      await clientB.call("authenticate", { clientApiVersion: 2 });
      await assert.rejects(() => clientB.call("controller_takeover"), (error) => error.code === "CONTROLLER_BUSY");
      const stop = await clientA.call("controller_stop");
      assert.equal(stop.stopped, true);
      await assert.rejects(
        () => clientA.call("list_applications"),
        (error) => error.code === "CONTROL_STOPPED",
      );
      const access = await clientA.call("request_access");
      assert.equal(access.ok, true);
      // 停止后健康面仍可用（宿主 checkHealth 依赖）。
      const infoAfterStop = await callBrokerMethod({
        socketPath,
        method: "broker_info",
        params: {},
        timeoutMs: 5_000,
      });
      assert.equal(infoAfterStop.pid, child.pid);
      clientA.close();
      clientB.close();
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      // 优雅退出应清理 socket 文件与 exit-log 落盘。
      assert.equal(existsSync(socketPath), false, "helper 退出后应清理 socket 文件");
      const exitLog = join(exitLogDir, `exit-${child.pid}.log`);
      assert.equal(existsSync(exitLog), true, "helper 退出应写 exit-log");
      rmSync(workDir, { recursive: true, force: true });
    }
  },
);
