// ============================================================
// R19（mac Helper 自研产线）：宿主侧 Helper 生命周期真实现
// ============================================================
// broker-server.js 的 createProductCuaHelperHost 在 darwin 下委托到本模块（非 darwin 保持
// 恒不可用占位）。合同面=broker-server.d.ts 的 CuaHelperHost：
//   安装(installer.ensureInstalled→~/.freecodez/computer-use 稳定身份) → 验签
//   (identity.json bundleId + lipo arch + codesign --verify，依赖由 broker-server 注入默认)
//   → spawn(exec, [entry, --socket, --parent-pid]) → probeHelperHealth pid 对账 → transport。
// node.ts 的 agent env 注入按「warm=快速健康检查 / cold=1s deadline race + reserved tuple」
// 消费本接口；本实现 reservedTransport 在健康对账通过后立即可用（helper 冷启动通常 <1s）。
//
// 环依赖说明：本模块只 import ../broker.js 与 ../broker-helper-constants.js，
// buildHelperOpenArgs 经参数注入（单一事实源在 broker-server.js，避免环）。

import { spawn as childProcessSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { callBrokerMethod, CuaHelperError, mintBrokerSocketPath, probeHelperHealth } from "../broker.js";
import {
  DEV_CUA_HELPER_BUNDLE_ID,
  HELPER_BUNDLE_ID,
  HELPER_DISPLAY_NAME,
  HELPER_ENTRY_RELATIVE_PATH,
} from "../broker-helper-constants.js";

const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const TERMINATE_GRACE_MS = 5_000;
const TERMINATE_KILL_GRACE_MS = 2_000;
const PERMISSION_PROBE_TIMEOUT_MS = 5_000;
const ACCEPTED_BUNDLE_IDS = new Set([HELPER_BUNDLE_ID, DEV_CUA_HELPER_BUNDLE_ID]);
const STDERR_CAPTURE_LIMIT_BYTES = 64 * 1024;

function wrapLogger(logger) {
  const write = (level, message, data) => {
    try {
      logger?.[level]?.(undefined, message, data);
    } catch {
      // 日志面尽力：绝不因 logger 异常折断 Helper 生命周期。
    }
  };
  return {
    info: (message, data) => write("info", message, data),
    warn: (message, data) => write("warn", message, data),
    error: (message, data) => write("error", message, data),
    debug: (message, data) => write("debug", message, data),
  };
}

function helperExecutablePath(appPath) {
  return join(appPath, "Contents", "MacOS", basename(appPath).replace(/\.app$/, ""));
}

function helperEntryPath(appPath) {
  // 布局与 build 脚本/broker-server open 形态共用同一常量（单源防漂移）。
  return join(appPath, HELPER_ENTRY_RELATIVE_PATH);
}

function defaultSpawnProcess(executablePath, args, options) {
  return childProcessSpawn(executablePath, args, options);
}

function waitForExit(childProcess, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    childProcess.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export function createMacProductHelperHost(options = {}) {
  const env = options.env ?? process.env;
  const logger = wrapLogger(options.logger);
  const installer = options.helperInstaller;
  const buildOpenArgs = options.buildHelperOpenArgs;
  const healthTimeoutMs =
    typeof options.healthTimeoutMs === "number" && options.healthTimeoutMs > 0
      ? options.healthTimeoutMs
      : DEFAULT_HEALTH_TIMEOUT_MS;
  const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  const healthProbe = options.healthProbe ?? ((socketPath, probeOptions) => probeHelperHealth(socketPath, probeOptions));
  if (typeof installer?.ensureInstalled !== "function" || typeof installer?.verifyInstalled !== "function") {
    throw new CuaHelperError("mac Computer Use Helper host requires an installer", {
      code: "helper_unavailable",
    });
  }
  if (typeof buildOpenArgs !== "function") {
    throw new CuaHelperError("mac Computer Use Helper host requires buildHelperOpenArgs", {
      code: "helper_unavailable",
    });
  }

  let generation = 0;
  let child = null;
  let adopted = false;
  let transport = null;
  let startupPromise = null;
  let stopPromise = null;

  const handleFrom = (tuple) => ({
    socketPath: tuple.socketPath,
    launchSocketPath: tuple.socketPath,
    pluginAuthority: tuple.pluginAuthority,
    helperAppPath: tuple.helperAppPath,
    bundleId: tuple.bundleId ?? null,
    pid: tuple.pid ?? null,
  });

  async function terminateChild(target) {
    if (target.exitObserved) return;
    try {
      target.process.kill("SIGTERM");
    } catch {
      // 已退出或不可杀：走 exit 等待兜底。
    }
    if (await waitForExit(target.process, TERMINATE_GRACE_MS)) return;
    try {
      target.process.kill("SIGKILL");
    } catch {
      // 尽力。
    }
    await waitForExit(target.process, TERMINATE_KILL_GRACE_MS);
  }

  async function launch() {
    const myGeneration = ++generation;
    const appPath = await installer.ensureInstalled();
    await installer.verifyInstalled(appPath);
    const executablePath = helperExecutablePath(appPath);
    const entryPath = helperEntryPath(appPath);
    if (!existsSync(executablePath) || !existsSync(entryPath)) {
      throw new CuaHelperError(
        `Computer Use Helper app is incomplete (missing executable or entry): ${appPath}`,
        { code: "helper_unavailable" },
      );
    }
    const socketPath = mintBrokerSocketPath({ env });
    const pluginAuthority = randomUUID();
    // 多窗口/设置页共享（全面复查补）：稳定 socket 上已有健康 Helper（另一窗口的 host 或
    // standalone 拉起）时直接收养——不重复 spawn（helper 侧陈旧 socket 探测会让第二个实例
    // exit 4，导致本窗口 broker 路由永久降级）。收养来的 Helper 死亡由 checkHealth 兜底，
    // 下一次 demand boundary 重建。收养对象的 parent-pid 归属其真实 launcher，本 host 停止时
    // 不杀它（不拥有生命周期）。
    const existing = await healthProbe(socketPath, { timeoutMs: 1_500 });
    if (existing && Number.isInteger(existing.pid) && existing.pid > 0) {
      if (existing.bundleId && !ACCEPTED_BUNDLE_IDS.has(existing.bundleId)) {
        throw new CuaHelperError(
          `Computer Use Helper authorization subject mismatch: ${existing.bundleId}`,
          { code: "not_authorized" },
        );
      }
      child = null;
      adopted = true;
      transport = {
        socketPath,
        pluginAuthority,
        pid: existing.pid,
        bundleId: existing.bundleId ?? HELPER_BUNDLE_ID,
        helperAppPath: appPath,
      };
      logger.info("Computer Use Helper adopted from stable socket", {
        pid: existing.pid,
        socketPath,
      });
      return handleFrom(transport);
    }
    const helperEnv = { ...env };
    delete helperEnv.ELECTRON_RUN_AS_NODE;
    delete helperEnv.NODE_OPTIONS;
    const spawned = spawnProcess(
      executablePath,
      [entryPath, ...buildOpenArgs({ socketPath }, process.pid)],
      { env: helperEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    const state = { process: spawned, exitObserved: false, generation: myGeneration };
    adopted = false;
    let stderrTail = "";
    const collectStderr = (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-STDERR_CAPTURE_LIMIT_BYTES);
    };
    spawned.stderr?.on?.("data", collectStderr);
    const childFailure = new Promise((_, reject) => {
      spawned.once("error", (error) => reject(error));
      spawned.once("exit", (code, signal) =>
        reject(
          new CuaHelperError(
            `Computer Use Helper exited during startup (code=${code} signal=${signal}) stderr=${stderrTail.slice(-2000)}`,
            { code: "helper_unavailable" },
          ),
        ),
      );
    });
    child = state;
    try {
      const health = await Promise.race([
        healthProbe(socketPath, { timeoutMs: healthTimeoutMs }),
        childFailure,
      ]);
      if (!health || health.pid !== spawned.pid) {
        throw new CuaHelperError(
          `Computer Use Helper health mismatch (expected pid ${spawned.pid}, observed ${health?.pid ?? "none"})`,
          { code: "helper_unavailable" },
        );
      }
      if (health.bundleId && !ACCEPTED_BUNDLE_IDS.has(health.bundleId)) {
        throw new CuaHelperError(
          `Computer Use Helper authorization subject mismatch: ${health.bundleId}`,
          { code: "not_authorized" },
        );
      }
      transport = {
        socketPath,
        pluginAuthority,
        pid: spawned.pid,
        bundleId: health.bundleId ?? HELPER_BUNDLE_ID,
        helperAppPath: appPath,
      };
      logger.info("Computer Use Helper started", { pid: spawned.pid, socketPath });
      return handleFrom(transport);
    } catch (error) {
      await terminateChild(state).catch(() => undefined);
      throw error instanceof CuaHelperError
        ? error
        : new CuaHelperError(
            `Computer Use Helper failed to start: ${error instanceof Error ? error.message : String(error)}`,
            { code: "helper_unavailable" },
          );
    } finally {
      spawned.once("exit", () => {
        state.exitObserved = true;
        if (child === state) child = null;
        if (transport && transport.pid === spawned.pid) {
          transport = null;
          logger.warn("Computer Use Helper exited unexpectedly", { pid: spawned.pid });
        }
      });
    }
  }

  function start() {
    // 契约（node.ts 注释）：start() 对已运行 Helper 直接返回既有 handle，不做健康探测。
    // 收养形态（无 child）与托管形态同权。
    if (startupPromise) return startupPromise;
    if (transport && (adopted || (child && !child.exitObserved))) {
      return Promise.resolve(handleFrom(transport));
    }
    startupPromise = launch().finally(() => {
      startupPromise = null;
    });
    return startupPromise;
  }

  async function doStop() {
    const current = child;
    generation += 1;
    transport = null;
    child = null;
    adopted = false;
    if (!current) return;
    await terminateChild(current);
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = doStop().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }

  async function restart() {
    await stop();
    return await start();
  }

  async function checkHealth(timeoutMs = 5_000) {
    const tuple = transport;
    if (!tuple) {
      throw new CuaHelperError("Computer Use Helper is not running", { code: "helper_unavailable" });
    }
    const health = await healthProbe(tuple.socketPath, { timeoutMs });
    if (!health || health.pid !== tuple.pid) {
      throw new CuaHelperError(
        `Computer Use Helper health mismatch (expected pid ${tuple.pid}, observed ${health?.pid ?? "none"})`,
        { code: "helper_unavailable" },
      );
    }
    return health;
  }

  async function waitForTransport(timeoutMs = 5_000) {
    if (transport) return { ...transport };
    const pending = startupPromise;
    if (!pending) {
      throw new CuaHelperError("Computer Use Helper transport is not starting", {
        code: "helper_unavailable",
      });
    }
    const timeout = new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new CuaHelperError("Computer Use Helper transport wait timed out", { code: "timeout" })),
        timeoutMs,
      );
      timer.unref?.();
    });
    await Promise.race([pending, timeout]);
    if (!transport) {
      throw new CuaHelperError("Computer Use Helper transport is unavailable after startup", {
        code: "helper_unavailable",
      });
    }
    return { ...transport };
  }

  async function callPermissionMethod(method) {
    const tuple = transport;
    if (!tuple) {
      throw new CuaHelperError("Computer Use Helper is not running", { code: "helper_unavailable" });
    }
    return await callBrokerMethod({
      socketPath: tuple.socketPath,
      method,
      params: {},
      timeoutMs: PERMISSION_PROBE_TIMEOUT_MS,
    });
  }

  async function queryScreenCaptureProbe() {
    try {
      const status = await callPermissionMethod("screen_capture_status");
      const authorized = status?.authorized === true;
      return {
        ok: authorized,
        reason: authorized ? "granted" : "screen recording permission not granted to FreeCodeZ Computer Use",
      };
    } catch (error) {
      // R16.2：失败 reason 必须携带实际错误摘要，不得虚报 starting up。
      return {
        ok: false,
        reason: `screen capture probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async function queryScreenRecordingPreflight() {
    try {
      const status = await callPermissionMethod("screen_capture_status");
      if (status?.authorized === true) return "granted";
      if (status?.authorized === false) return "denied";
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  async function queryPermissionStatus() {
    const owner = { display_name: HELPER_DISPLAY_NAME };
    try {
      const status = await callPermissionMethod("permission_status");
      const accessibility =
        status?.accessibility_trusted === true
          ? "granted"
          : status?.accessibility_trusted === false
            ? "denied"
            : "unknown";
      const screenRecording =
        status?.screen_capture === true ? "granted" : status?.screen_capture === false ? "denied" : "unknown";
      return {
        grant_owner: HELPER_BUNDLE_ID,
        owner,
        accessibility,
        screen_recording: screenRecording,
      };
    } catch (error) {
      return {
        grant_owner: HELPER_BUNDLE_ID,
        owner,
        accessibility: "unknown",
        screen_recording: "unknown",
        reason: `permission_status probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return {
    get running() {
      // 收养形态无 child：socket 上健康即 running（checkHealth 兜底判死）。
      return Boolean(transport && (adopted || (child && !child.exitObserved)));
    },
    get socketPath() {
      return transport?.socketPath ?? null;
    },
    get pluginAuthority() {
      return transport?.pluginAuthority ?? null;
    },
    get reservedTransport() {
      return transport ? { ...transport } : undefined;
    },
    start,
    stop,
    restart,
    restartAfterCurrentStart: restart,
    waitForTransport,
    checkHealth,
    queryScreenCaptureProbe,
    queryScreenRecordingPreflight,
    queryPermissionStatus,
  };
}
