// ============================================================
// R19（mac Helper 自研产线）：FreeCodeZ Computer Use 进程入口
// ============================================================
// 运行形态：.app 束内 node 底座以
//   `<exec> Contents/Resources/dist/helper-main.mjs --socket <path> --parent-pid <pid> [--exit-log <dir>]`
// 拉起（argv 合同=broker-server.js buildHelperOpenArgs 单源；直跑源码时 argv[1] 即本文件，
// 解析容忍多余位置参数）。协议复用 broker.js 服务端分发（parseRequestLine/dispatchRequest），
// 方法面复用 koffi 方法表（createKoffiBrokerMethods，与进程内路线同一实现）。
//
// 本文件补齐 helper 专属语义：
//   - 响应回显请求 id（callBrokerMethod 按 id 对账，okResponse/errorResponse 不带 id）；
//   - controller 单控制器门（R4 helper 侧门：动作类按连接归属+90s TTL，冲突 CONTROLLER_BUSY）；
//   - kill switch（R5：controller_stop 后除 request_access/诊断/连接级外全部 CONTROL_STOPPED）；
//   - 启动认领 90s TTL 自弃（防孤儿权限主体，对齐 windows-helper 语义）；
//   - 父进程 5s 看门狗 + 陈旧 socket 先探后清 + socket 0600；
//   - broker_info 补 pid/authorization_subject（宿主健康对账与 TCC 属主归因）。
// 未实现方法（pip_*/press_key_to_app 等）不在方法表 → method_not_found，与既有语义一致。

import { appendFileSync, chmodSync, existsSync, mkdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { createServer, connect as tcpConnect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BrokerError,
  CUA_BROKER_IPC_VERSION,
  dispatchRequest,
  errorResponse,
  errorResponseFromException,
  isReadOnlyBrokerMethod,
  parseRequestLine,
  serializeResponse,
} from "../broker.js";
import { HELPER_BUNDLE_ID, HELPER_DISPLAY_NAME } from "../broker-helper-constants.js";
import { createKoffiBrokerMethods } from "./koffi-broker-methods.js";
import { runPermissionRequestMode } from "./permission-request-mode.js";

const STARTUP_CLAIM_TTL_MS = 90_000;
const PARENT_WATCH_INTERVAL_MS = 5_000;
const STANDALONE_IDLE_EXIT_MS = 300_000;
const STANDALONE_IDLE_POLL_MS = 30_000;
const STALE_SOCKET_PROBE_MS = 400;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
// R5 放行语义：broker_info/ping/authenticate 是连接级/健康面（各分支特判直通），
// request_access 是唯一被豁免的工具方法（下方只读分支），controller_status/controller_stop
// 是诊断与幂等停止面（下方特判直通）；其余（含观测与全部动作）停止后一律 CONTROL_STOPPED。

/** 解析 helper argv；--socket/--parent-pid/--exit-log 支持「flag 值」与「flag=值」两种形态；
 * --request-permissions 为布尔旗标（R21c 一次性权限请求模式）。 */
export function parseHelperArgs(argv) {
  const values = {
    socketPath: undefined,
    parentPid: undefined,
    exitLogTarget: undefined,
    requestPermissions: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== "string" || !token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    const flag = eq > 2 ? token.slice(2, eq) : token.slice(2);
    const inline = eq > 2 ? token.slice(eq + 1) : undefined;
    if (flag === "request-permissions") {
      values.requestPermissions = true;
      continue;
    }
    if (flag !== "socket" && flag !== "parent-pid" && flag !== "exit-log") continue;
    const value = inline !== undefined ? inline : argv[index + 1];
    if (typeof value !== "string" || !value || value.startsWith("--")) continue;
    if (inline === undefined) index += 1;
    if (flag === "socket") values.socketPath = value;
    else if (flag === "parent-pid") values.parentPid = Number(value);
    else values.exitLogTarget = value;
  }
  return values;
}

/**
 * controller 单控制器门（R4/R5 helper 侧）。owner=连接 key；TTL 内的动作调用刷新活跃水位，
 * 过期或无主时首个动作连接接管（health 探测是只读方法，不会抢走控制器——与
 * 「claim=首条成功 broker_info」的启动认领语义互补：启动认领只决定进程存续，不决定控制器归属）。
 */
export function createControllerClaim({ ttlMs = STARTUP_CLAIM_TTL_MS, now = () => Date.now() } = {}) {
  let owner = null;
  let lastActivityAt = 0;
  let stopped = false;
  return {
    get stopped() {
      return stopped;
    },
    markStopped() {
      stopped = true;
      owner = null;
    },
    release(connectionKey) {
      if (owner === connectionKey) owner = null;
    },
    ensureOwner(connectionKey) {
      if (stopped) {
        throw new BrokerError("computer control was stopped for this helper session", {
          code: "CONTROL_STOPPED",
        });
      }
      const alive = owner !== null && now() - lastActivityAt < ttlMs;
      if (owner === null || !alive) owner = connectionKey;
      if (owner !== connectionKey) {
        throw new BrokerError("another controller session owns computer control", {
          code: "CONTROLLER_BUSY",
          details: { owner, retry: "never" },
        });
      }
      lastActivityAt = now();
    },
    snapshot() {
      return {
        stopped,
        controller: owner,
        idle_ms: owner === null ? null : now() - lastActivityAt,
        ttl_ms: ttlMs,
      };
    },
  };
}

/**
 * koffi 诊断文案按 helper 语境改写：broker 路由的 TCC 主体是「FreeCodeZ Computer Use」，
 * 进程内诊断默认文案指向 FreeCodeZ.app（对 koffi 进程内路线正确、对 helper 误导）。
 */
function rebindPermissionText(value) {
  if (typeof value === "string") {
    return value.replaceAll("FreeCodeZ.app", "FreeCodeZ Computer Use");
  }
  if (Array.isArray(value)) return value.map(rebindPermissionText);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = rebindPermissionText(item);
    return out;
  }
  return value;
}

/**
 * 组装单连接 backend：controller 门只拦动作类（非只读 broker 方法），连接级方法与
 * 诊断面直通。controller_* 三方法由本层提供（koffi 方法表不含；进程内路线的策略链在
 * ComputerUseRuntime 内实现，不经此面）。
 */
export function buildConnectionBackend({ methods, claim, connectionKey }) {
  return new Proxy(methods, {
    get(target, property, receiver) {
      if (typeof property !== "string") return Reflect.get(target, property, receiver);
      if (property === "authenticate") {
        return async () => ({ authenticated: true, serverApiVersion: CUA_BROKER_IPC_VERSION });
      }
      if (property === "permission_status") {
        // 双消费面合一：koffi 布尔形状（宿主 queryPermissionStatus 读 accessibility_trusted/
        // screen_capture）+ 设置页报告形状（node.ts 稳定 socket 直查读 grant_owner/owner/
        // accessibility 枚举/screen_recording/accessibility_probe——原 koffi 诊断形状缺这些键，
        // standalone 状态映射会把布尔当枚举用）。
        const underlying = target.permission_status;
        return async (params) => {
          const base = underlying ? await underlying(params) : { ok: true };
          const accessibilityGranted =
            base?.accessibility_trusted === true || base?.accessibility === true;
          const screenGranted = base?.screen_capture === true;
          return {
            ...base,
            grant_owner: HELPER_BUNDLE_ID,
            owner: { display_name: HELPER_DISPLAY_NAME },
            accessibility: accessibilityGranted ? "granted" : "denied",
            screen_recording: screenGranted ? "granted" : "denied",
            accessibility_probe: {
              ok: accessibilityGranted,
              classification: accessibilityGranted ? "functional" : "denied",
            },
          };
        };
      }
      if (property === "broker_info") {
        const underlying = target.broker_info;
        return async (params) => {
          const base = underlying ? await underlying(params) : { ok: true };
          return {
            ...base,
            // helper 语境的 backend 标识（koffi 方法表自报 koffi-in-process 指进程内路线）；
            // 宿主 probeHelperHealth 按 pid 与 spawn 子进程对账、按 authorization_subject 归因 TCC 属主。
            backend: "freecodez-cua-helper",
            pid: process.pid,
            authorization_subject: HELPER_BUNDLE_ID,
          };
        };
      }
      if (property === "controller_status") {
        return async () => ({ ok: true, ...claim.snapshot() });
      }
      if (property === "controller_takeover") {
        return async () => {
          claim.ensureOwner(connectionKey);
          return { ok: true, ...claim.snapshot() };
        };
      }
      if (property === "controller_stop") {
        return async () => {
          claim.markStopped();
          return { ok: true, stopped: true };
        };
      }
      const underlying = target[property];
      if (typeof underlying !== "function") return underlying;
      if (isReadOnlyBrokerMethod(property)) {
        // R5：stop 后除 request_access（只读权限探测）外全部 CONTROL_STOPPED——只读观测面同拦。
        if (claim.stopped && property !== "request_access") {
          throw new BrokerError("computer control was stopped for this helper session", {
            code: "CONTROL_STOPPED",
          });
        }
        if (
          property === "request_access" ||
          property === "permission_status" ||
          property === "screen_capture_status" ||
          property === "screen_capture_probe" ||
          property === "supports_accessibility" ||
          property === "input_permission_status"
        ) {
          return async (params) => rebindPermissionText(await underlying(params));
        }
        return underlying;
      }
      return async (params) => {
        if (claim.stopped) {
          throw new BrokerError("computer control was stopped for this helper session", {
            code: "CONTROL_STOPPED",
          });
        }
        claim.ensureOwner(connectionKey);
        return underlying(params);
      };
    },
  });
}

function writeExitLog(exitLogTarget, reason, detail) {
  if (!exitLogTarget) return;
  try {
    // 兼容两种合同键：exitLogDir（目录，写 exit-<pid>.log 进去）与 exitLogPath（文件，直接追加）。
    // 统一在 helper 侧按存在性分派，调用方无需对齐。
    let stats;
    try {
      stats = statSync(exitLogTarget);
    } catch {
      stats = undefined;
    }
    const line = `${JSON.stringify({ ts: new Date().toISOString(), reason, detail })}\n`;
    if (stats?.isFile()) {
      appendFileSync(exitLogTarget, line, "utf8");
      return;
    }
    mkdirSync(exitLogTarget, { recursive: true });
    appendFileSync(join(exitLogTarget, `exit-${process.pid}.log`), line, "utf8");
  } catch {
    // 落盘尽力：目录只读等不阻断退出路径。
  }
}

async function isSocketAlive(socketPath) {
  return await new Promise((resolve) => {
    const probe = tcpConnect(socketPath);
    const finish = (alive) => {
      probe.destroy();
      resolve(alive);
    };
    probe.once("connect", () => finish(true));
    probe.once("error", () => finish(false));
    setTimeout(() => finish(false), STALE_SOCKET_PROBE_MS).unref?.();
  });
}

export async function runHelperMain({
  argv = process.argv,
  exit = (code) => process.exit(code),
  diagnostic = (text) => process.stderr.write(text),
  now = () => Date.now(),
  standaloneIdleExitMs = STANDALONE_IDLE_EXIT_MS,
  permissionRequests,
} = {}) {
  const { socketPath, parentPid, exitLogTarget, requestPermissions } = parseHelperArgs(argv);
  // R21c：一次性权限请求模式（实现体在 permission-request-mode.js，独立模块守 max-lines）。
  if (requestPermissions) {
    await runPermissionRequestMode({ diagnostic, exit, now, permissionRequests });
    return;
  }
  // parent-pid 可选：托管形态（宿主 spawn）必带（父进程 5s 看门狗绑定生命周期）；
  // standalone 形态（设置页经 `open` 拉起，官方语义「无 launcher-pid → 300s 无访问自动休眠」）
  // 不带，由空闲看门狗接管存续。
  if (!socketPath || (parentPid !== undefined && (!Number.isSafeInteger(parentPid) || parentPid <= 0))) {
    diagnostic("helper-main: --socket <path> is required (--parent-pid <pid> optional)\n");
    exit(64);
    return;
  }
  // 三道保险之三（fail-closed）：绑定不可用 → 直接退出，宿主按 helper 启动失败收敛。
  const backend = createKoffiBrokerMethods({ allowActions: true });
  if (!backend) {
    diagnostic("helper-main: koffi bindings unavailable; refusing to start\n");
    writeExitLog(exitLogTarget, "koffi-unavailable");
    exit(2);
    return;
  }
  if (existsSync(socketPath)) {
    if (await isSocketAlive(socketPath)) {
      diagnostic(`helper-main: another broker already owns ${socketPath}\n`);
      writeExitLog(exitLogTarget, "socket-owned");
      exit(4);
      return;
    }
    try {
      unlinkSync(socketPath);
    } catch {
      // 清不掉由 listen 的 EADDRINUSE 兜底报错退出。
    }
  }
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  const claim = createControllerClaim();
  let claimed = false;
  let shuttingDown = false;
  let connectionCounter = 0;
  const sockets = new Set();
  const server = createServer((socket) => {
    const connectionKey = `conn-${(connectionCounter += 1)}`;
    const connectionBackend = buildConnectionBackend({
      methods: backend.methods,
      claim,
      connectionKey,
    });
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on("data", async (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) {
          if (buffer.byteLength > MAX_LINE_BYTES) {
            socket.write(
              serializeResponse({
                id: null,
                ...errorResponse("request line exceeded the 16 MiB limit", { code: "invalid_request" }),
              }),
            );
            socket.destroy();
          }
          return;
        }
        const line = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        const request = parseRequestLine(line);
        // 响应 id 必须按原始类型回显（callBrokerMethod 以数字 id 记账对账；
        // parseRequestLine 会把 id 规范成 string，仅用于方法分发校验）。
        let rawId = null;
        if (request) {
          try {
            rawId = JSON.parse(line)?.id ?? null;
          } catch {
            rawId = null;
          }
        }
        let response;
        if (!request) {
          response = {
            id: null,
            ...errorResponse("Request line is not valid JSON with a string method", {
              code: "invalid_request",
            }),
          };
        } else {
          noteActivity();
          try {
            response = await dispatchRequest(connectionBackend, request);
            if (request.method === "broker_info" && response.ok) claimed = true;
          } catch (error) {
            response = { id: rawId, ...errorResponseFromException(error) };
          }
        }
        socket.write(serializeResponse({ id: rawId, ...response }));
      }
    });
    socket.once("close", () => {
      sockets.delete(socket);
      claim.release(connectionKey);
    });
    socket.once("error", () => {
      sockets.delete(socket);
    });
  });
  server.once("error", (error) => {
    diagnostic(`helper-main: broker socket error: ${error?.message ?? String(error)}\n`);
    writeExitLog(exitLogTarget, "socket-error", String(error?.message ?? error));
    exit(3);
  });
  const gracefulExit = (code, reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(startupClaimTimer);
    clearInterval(parentTimer);
    clearInterval(idleTimer);
    try {
      server.close();
    } catch {
      // 尽力。
    }
    for (const socket of sockets) socket.destroy();
    backend.dispose();
    try {
      if (existsSync(socketPath)) unlinkSync(socketPath);
    } catch {
      // 尽力。
    }
    writeExitLog(exitLogTarget, reason);
    exit(code);
  };
  const startupClaimTimer = setTimeout(() => {
    // 对齐 windows-helper：90s 无人认领即自弃，避免孤儿权限主体常驻。
    if (!claimed && !shuttingDown) gracefulExit(0, "startup-claim-timeout");
  }, STARTUP_CLAIM_TTL_MS);
  startupClaimTimer.unref?.();
  // 托管形态：父进程 5s 看门狗绑定生命周期（standalone 形态此 interval 空转，由 idleTimer 接管）。
  const parentTimer = setInterval(() => {
    if (parentPid === undefined) return;
    try {
      process.kill(parentPid, 0);
    } catch {
      gracefulExit(0, "parent-exit");
    }
  }, PARENT_WATCH_INTERVAL_MS);
  parentTimer.unref?.();
  let lastActivityAt = now();
  const idleTimer = setInterval(() => {
    if (parentPid === undefined && now() - lastActivityAt > standaloneIdleExitMs && !shuttingDown) {
      gracefulExit(0, "standalone-idle");
    }
  }, STANDALONE_IDLE_POLL_MS);
  idleTimer.unref?.();
  const noteActivity = () => {
    lastActivityAt = now();
  };
  process.once("SIGTERM", () => gracefulExit(0, "sigterm"));
  process.once("SIGINT", () => gracefulExit(0, "sigint"));
  server.listen(socketPath, () => {
    try {
      chmodSync(socketPath, 0o600);
    } catch {
      // 尽力收紧。
    }
    diagnostic(`helper-main: listening on ${socketPath}\n`);
  });
}

// 直跑判定用双方 realpath：打包产物是真实文件自然相等；开发/测试期经 symlink 指到源码时，
// argv[1] 保留链接路径而 ESM 的 import.meta.url 已被 node 解析成真实路径，不比 realpath 会漏跑。
const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void runHelperMain();
}
