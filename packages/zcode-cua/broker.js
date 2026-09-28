/* eslint-disable max-lines -- helper NDJSON 协议面(42 方法表/错误族/客户端/服务端分发/固定命名)与 broker.d.ts 契约一一对应,拆分会把同一协议的分帧语义散到多处。 */
// FreeCodeZ fork(电脑控制能力补位 B2):helper NDJSON 客户端/服务端分发、方法白名单与
// socket 固定命名的真实现(占位包在此处全部 fail-closed)。行为对齐 ZCode 3.14.3 官方
// producer(windows-helper.js 14520-14655 / node-repl-host 87341-87388 内联代码),
// 不要求代码同源;契约面以本目录 .d.ts 为准,签名不改。
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const BROKER_SOCKET_ENV = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
export const BROKER_UNAVAILABLE_ENV = "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE";

// 版本铁律连接期闸:clientApiVersion > CUA_BROKER_IPC_VERSION 直接 version_mismatch(规格 R12)。
export const CUA_BROKER_IPC_VERSION = 2;
export const BROKER_API_VERSION = "ZCodeComputerUseIPC-1";
// 只读方法软超时:回 timeout 但底层继续;动作类永不软超时,保 possibly_sent 语义准确。
export const READ_ONLY_SOFT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

export class BrokerError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use broker is unavailable.");
    this.name = "BrokerError";
    this.code = options.code ?? "unavailable";
    if (options.details !== undefined) this.details = options.details;
  }
}

export class CuaHelperError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use Helper is unavailable.");
    this.name = "CuaHelperError";
    this.code = options.code ?? "helper_unavailable";
    if (options.details !== undefined) this.details = options.details;
  }
}

export function isCuaHelperError(value) {
  return value instanceof CuaHelperError;
}

const brokerErrorFactory = (code) => (message, details) =>
  new BrokerError(message ?? code, { code, details });

export const notAuthorized = brokerErrorFactory("not_authorized");
export const notSelectable = brokerErrorFactory("not_selectable");
export const notSettable = brokerErrorFactory("not_settable");
export const elementUnavailable = brokerErrorFactory("element_unavailable");
export const actionUnavailable = brokerErrorFactory("action_unavailable");
export const foregroundRequired = brokerErrorFactory("foreground_required");

/**
 * helper broker 方法白名单:42 个注册方法,与 windows-helper.js 的 BROKER_METHODS 逐项一致。
 * 官方注释自述"49→43"与代码不符,以代码机器计数 42 为准;`authenticate`/`ping` 是数组外
 * 连接级保留方法,分发前特判;6 个 `pip_live_probe_*` 测试探针已在上游删除,不得复活。
 */
export const BROKER_METHODS = Object.freeze([
  // 诊断(10)
  "broker_info",
  "controller_status",
  "controller_takeover",
  "controller_stop",
  "request_access",
  "permission_status",
  "input_permission_status",
  "screen_capture_status",
  "screen_capture_probe",
  "supports_accessibility",
  // 观测(6)
  "list_applications",
  "application_info",
  "list_windows",
  "capture_app",
  "element_at_point",
  "read_element",
  // 动作(17)
  "click",
  "scroll",
  "drag",
  "type_text",
  "type_text_to_app",
  "press_key",
  "press_key_to_app",
  "hold_key",
  "hold_key_to_app",
  "cancel_input_holds",
  "element_press",
  "element_show_menu",
  "element_focus",
  "element_set_value",
  "element_perform_action",
  "element_select_text",
  "paste",
  // 防抢焦点(3)
  "prevent_activation",
  "reenable_activation",
  "is_focus_steal_prevented",
  // PiP(6)
  "pip_start",
  "pip_stop",
  "pip_is_running",
  "pip_clear_dismissed",
  "pip_session_handshake",
  "pip_session_event",
]);

const BROKER_METHOD_SET = new Set(BROKER_METHODS);

export function isBrokerMethod(method) {
  return BROKER_METHOD_SET.has(method);
}

/**
 * 只读子集:允许 15s 软超时并绕过 controllerLease。`request_access` 属只读——
 * 必须 prompt=false、不得预热 capture/automation 权限(权限请求手势只归 Host UI)。
 * `screen_capture_probe` 会真抓一小张屏,但纯观测无用户可见副作用。
 */
const READ_ONLY_BROKER_METHODS = new Set([
  "broker_info",
  "controller_status",
  "request_access",
  "input_permission_status",
  "screen_capture_status",
  "screen_capture_probe",
  "supports_accessibility",
  "permission_status",
  "list_applications",
  "application_info",
  "list_windows",
  "capture_app",
  "element_at_point",
  "read_element",
  "is_focus_steal_prevented",
  "pip_is_running",
  "pip_clear_dismissed",
  "pip_session_handshake",
]);

export function isReadOnlyBrokerMethod(method) {
  return READ_ONLY_BROKER_METHODS.has(method);
}

// ───────────────────────────────── socket 命名(官方固定命名;占位包的随机 sock 形状废弃) ─────────────────────────────────

const BROKER_SOCKET_FILENAME = "broker.sock";
export const WINDOWS_NAMED_PIPE_PREFIX = "\\\\.\\pipe\\zcode-cua-helper-";

function brokerRuntimeDir(env) {
  const xdg = env.XDG_RUNTIME_DIR;
  if (typeof xdg === "string" && xdg.trim().length > 0) {
    return join(xdg, "zcode-cua");
  }
  if (process.platform === "win32") {
    // FreeCodeZ fork:数据目录族随 P1 隔离到 freecodez,避免与原版 ZCode 共享运行时目录。
    // (win32 主路径走命名管道,此分支仅兜底;zcode-cua 目录前缀属契约族不改。)
    const localAppData = env.LOCALAPPDATA;
    if (typeof localAppData === "string" && localAppData.trim().length > 0) {
      return join(localAppData, "freecodez", "cua-broker");
    }
    return join(homedir(), "AppData", "Local", "freecodez", "cua-broker");
  }
  if (process.platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : "nouid";
    return join("/tmp", `zcode-cua-${uid}`);
  }
  return join(homedir(), ".freecodez", "cua-broker");
}

export function isWindowsNamedPipePath(path) {
  return typeof path === "string" && path.startsWith("\\\\.\\pipe\\");
}

export function mintBrokerSocketPath(options = {}) {
  const env = options.env ?? process.env;
  // 固定命名(master spec §6.3 裁定):win32 恒 \\.\pipe\zcode-cua-helper-default;
  // POSIX 恒 <runtimeDir>/broker.sock。helper bind 与宿主 resolve 必须同名,随机名会互不可见。
  if (process.platform === "win32") {
    return `${WINDOWS_NAMED_PIPE_PREFIX}default`;
  }
  const dir = typeof options.dir === "string" && options.dir.trim() ? options.dir : brokerRuntimeDir(env);
  return join(dir, BROKER_SOCKET_FILENAME);
}

export function resolveBrokerSocketPath(options = {}) {
  const env = options.env ?? process.env;
  const explicit = env[BROKER_SOCKET_ENV];
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit;
  }
  return mintBrokerSocketPath(options);
}

// ───────────────────────────────── 请求行/响应分帧(服务端分发面) ─────────────────────────────────

export function parseRequestLine(line) {
  if (typeof line !== "string") return undefined;
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const { id, method, params } = parsed;
  if (typeof method !== "string" || !method) return undefined;
  if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") {
    return undefined;
  }
  return {
    id: id === undefined || id === null ? null : String(id),
    method,
    ...(params !== undefined ? { params } : {}),
  };
}

export function okResponse(result) {
  return { ok: true, result };
}

export function errorResponse(message, options = {}) {
  return {
    ok: false,
    error: { message, ...(options.code ? { code: options.code } : {}) },
  };
}

export function errorResponseFromException(error) {
  if (error instanceof BrokerError || error instanceof CuaHelperError) {
    return errorResponse(error.message, { code: error.code });
  }
  return errorResponse(error instanceof Error ? error.message : String(error));
}

export function serializeResponse(response) {
  return `${JSON.stringify(response)}\n`;
}

/**
 * 服务端分发:method 必须在 42 方法表内(连接级 authenticate/ping 特判),
 * backend 提供同名 handler(`backend[method]` 或 `backend.handlers[method]`)。
 * 未知方法回 method_not_found;handler 抛 BrokerError 时保留其错误码。
 */
export async function dispatchRequest(backend, request) {
  const method = request?.method;
  if (typeof method !== "string" || !method) {
    return errorResponse("request method is required", { code: "invalid_request" });
  }
  try {
    if (method === "ping") {
      const handler = lookupHandler(backend, "ping");
      return okResponse(handler ? await handler(request.params) : { serverApiVersion: CUA_BROKER_IPC_VERSION });
    }
    if (method === "authenticate") {
      const handler = lookupHandler(backend, "authenticate");
      return okResponse(handler ? await handler(request.params) : { authenticated: true });
    }
    if (!isBrokerMethod(method)) {
      return errorResponse(`Unknown method: ${method}`, { code: "method_not_found" });
    }
    const handler = lookupHandler(backend, method);
    if (!handler) {
      return errorResponse(`Method is not implemented by this backend: ${method}`, {
        code: "method_not_found",
      });
    }
    return okResponse(await handler(request.params));
  } catch (error) {
    return errorResponseFromException(error);
  }
}

function lookupHandler(backend, method) {
  const direct = backend?.[method];
  if (typeof direct === "function") return direct;
  const nested = backend?.handlers?.[method];
  return typeof nested === "function" ? nested : undefined;
}

export async function handleRequestLine(backend, line) {
  const request = parseRequestLine(line);
  if (!request) {
    return errorResponse("Request line is not valid JSON with a string method", {
      code: "invalid_request",
    });
  }
  return await dispatchRequest(backend, request);
}

// ───────────────────────────────── NDJSON 客户端(callBrokerMethod) ─────────────────────────────────

/**
 * 连接 → authenticate(首请求)→ 业务方法,**单连接**(每条连接的首请求必须是
 * authenticate,helper 分发前特判)。
 *
 * 请求 `{id: 非负安全整数, method, params?}`,响应 `{id, ok:true, result}` /
 * `{id, ok:false, error:{code, message, details?}}`,行缓冲 16MiB。
 *
 * 失败语义(possibly_sent 判定的唯一来源,B2 单测锁定):
 * - 连接/握手失败:BrokerError(code=broker_unavailable, details.request_delivery_state="not_sent")
 * - 请求已写出但响应丢失/超时:details.request_delivery_state="possibly_sent"(绝不盲目重放)
 * - helper 显式错误:BrokerError(helper 的 code/details 原样保留)
 */
export async function callBrokerMethod(args) {
  const { socketPath, method, params, timeoutMs } = args;
  if (typeof socketPath !== "string" || !socketPath.trim()) {
    throw new BrokerError("Computer Use broker socket path is missing.", {
      code: "broker_unavailable",
      details: { request_delivery_state: "not_sent" },
    });
  }
  if (typeof method !== "string" || !method) {
    throw new BrokerError("broker method is required", { code: "invalid_request" });
  }
  const connection = normalizeConnectionIdentity(args.connection);
  const deadlineMs =
    typeof timeoutMs === "number" && timeoutMs > 0
      ? timeoutMs
      : isReadOnlyBrokerMethod(method)
        ? READ_ONLY_SOFT_TIMEOUT_MS
        : undefined;

  let requestWritten = false;
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    let nextId = 1;
    const pending = new Map();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      args.signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer =
      deadlineMs === undefined
        ? undefined
        : setTimeout(() => {
            // 超时时是否已下发决定收据语义:动作类绝不软超时在这里兜底,归 possibly_sent。
            finish(
              new BrokerError(`broker call "${method}" timed out after ${deadlineMs}ms`, {
                code: "timeout",
                details: {
                  request_delivery_state: requestWritten ? "possibly_sent" : "not_sent",
                },
              }),
            );
          }, deadlineMs);
    const onAbort = () => finish(new DOMException("aborted", "AbortError"));
    args.signal?.addEventListener("abort", onAbort, { once: true });

    const sendFrame = (requestMethod, requestParams) => {
      const id = nextId;
      nextId += 1;
      const payload = {
        id,
        method: requestMethod,
        ...(requestParams === undefined ? {} : { params: requestParams }),
      };
      return new Promise((resolveFrame, rejectFrame) => {
        pending.set(id, { method: requestMethod, resolve: resolveFrame, reject: rejectFrame });
        const frame = `${JSON.stringify(payload)}\n`;
        requestWritten = true;
        socket.write(frame, (error) => {
          if (error) {
            pending.delete(id);
            rejectFrame(
              new BrokerError(`broker request "${requestMethod}" could not be delivered`, {
                code: "broker_unavailable",
                details: { request_delivery_state: "not_sent", error_type: "write_failed" },
                cause: error,
              }),
            );
          }
        });
      });
    };

    socket.once("connect", () => {
      (async () => {
        // 连接级契约:authenticate 必须是首请求;显式调 authenticate/ping 时不代发。
        if (method !== "authenticate") {
          await sendFrame("authenticate", {
            clientApiVersion: CUA_BROKER_IPC_VERSION,
            ...connection,
          });
        }
        return await sendFrame(method, params ?? (method === "authenticate" ? undefined : {}));
      })().then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      );
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > DEFAULT_MAX_LINE_BYTES) {
        finish(
          new BrokerError("broker response exceeded the 16 MiB line limit", {
            code: "internal",
            details: { request_delivery_state: "delivered" },
          }),
        );
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          finish(
            new BrokerError("broker response line is not valid JSON", {
              code: "internal",
              details: { request_delivery_state: "delivered" },
              cause: error,
            }),
          );
          return;
        }
        const entry = pending.get(parsed?.id);
        if (!entry) {
          finish(
            new BrokerError("broker response id mismatch", {
              code: "internal",
              details: { request_delivery_state: "delivered" },
            }),
          );
          return;
        }
        pending.delete(parsed.id);
        if (parsed.ok === true) {
          entry.resolve(parsed.result);
          continue;
        }
        const failure = parsed.error ?? {};
        entry.reject(
          new BrokerError(
            typeof failure.message === "string" && failure.message
              ? failure.message
              : `broker method "${entry.method}" failed`,
            {
              code: typeof failure.code === "string" && failure.code ? failure.code : "internal",
              details: {
                request_delivery_state: "delivered",
                ...(failure.details && typeof failure.details === "object"
                  ? { ...failure.details }
                  : {}),
              },
            },
          ),
        );
      }
    });

    socket.once("error", (error) => {
      finish(
        new BrokerError(`Computer Use broker is unavailable (${error?.code ?? "socket_error"})`, {
          code: "broker_unavailable",
          details: {
            request_delivery_state: requestWritten ? "possibly_sent" : "not_sent",
            error_type: error?.code ?? "socket_error",
          },
          cause: error,
        }),
      );
    });
    socket.once("close", () => {
      finish(
        new BrokerError(`Computer Use broker closed before responding to "${method}"`, {
          code: "broker_unavailable",
          details: {
            request_delivery_state: requestWritten ? "possibly_sent" : "not_sent",
            error_type: "connection_closed",
          },
        }),
      );
    });
    if (args.signal?.aborted) onAbort();
  });
}

function normalizeConnectionIdentity(connection) {
  const identity = connection && typeof connection === "object" ? connection : {};
  return {
    client_type:
      typeof identity.client_type === "string" && identity.client_type
        ? identity.client_type
        : "zcode_cua_mcp",
    workspace_key: typeof identity.workspace_key === "string" ? identity.workspace_key : "",
    session_id: typeof identity.session_id === "string" ? identity.session_id : "",
    thread_id: typeof identity.thread_id === "string" ? identity.thread_id : "",
    connection_id:
      typeof identity.connection_id === "string" && identity.connection_id
        ? identity.connection_id
        : randomUUID(),
    // role 仅 PiP presentation 通道使用;该角色不能自报,helper 侧做对端验证(R15)。
    ...(typeof identity.role === "string" && identity.role ? { role: identity.role } : {}),
  };
}

/**
 * 健康探测:`broker_info` 往返即认领(broker 启动认领的官方语义,首个成功写回者胜)。
 * 按 perTryTimeoutMs 轮询直到 timeoutMs;失败返回全 null(不抛,占位包语义保持)。
 */
export async function probeHelperHealth(socketPath, options = {}) {
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 10_000;
  const pollIntervalMs = typeof options.pollIntervalMs === "number" ? options.pollIntervalMs : 250;
  const perTryTimeoutMs =
    typeof options.perTryTimeoutMs === "number" ? options.perTryTimeoutMs : 2_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const info = await callBrokerMethod({
        socketPath,
        method: "broker_info",
        params: {},
        timeoutMs: perTryTimeoutMs,
      });
      const pid = Number.isSafeInteger(info?.pid) ? info.pid : null;
      const bundleId =
        typeof info?.authorization_subject === "string" && info.authorization_subject
          ? info.authorization_subject
          : null;
      return { bundleId, pid };
    } catch {
      if (Date.now() + pollIntervalMs >= deadline) return { bundleId: null, pid: null };
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}
