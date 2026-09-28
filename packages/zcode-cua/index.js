// FreeCodeZ fork(电脑控制能力补位 B2):ComputerUseRuntime 真实现——14 工具 schema +
// 策略链(kill switch → controllerLease → 语义解析 → settle 收据)+ BrokerClient。
// 行为对齐官方 producer(工具层/策略链,规格 附录 A.1/B 与证据手册 §4);占位包的
// fail-closed 语义保留面:隐私(R6/R14)与 subagent 双拒。
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { BrokerError, callBrokerMethod, resolveBrokerSocketPath } from "./broker.js";
import {
  attachAppAssociationsMeta,
  notReadyPayloadForDelivery,
  notReadyResult,
  subagentUnavailableResult,
  toolError,
} from "./producer/tool-envelope.js";
import {
  APP_ASSOCIATION_MODE_BY_TOOL,
  MUTATING_TOOL_NAMES,
  parseToolArguments,
  SchemaError,
  TOOL_NAMES,
} from "./producer/tool-schema.js";
import { createToolHandlers, stateAppOf } from "./producer/tool-handlers.js";
import { CuaToolSession } from "./producer/tool-session.js";
import { resolveExpectedCuaHelperBuildId } from "./producer/helper-build-id.js";

const KILL_SWITCH_EXEMPT = new Set(["request_access", "stop_computer_control"]);
const TOOL_NAME_SET = new Set(TOOL_NAMES);

/** kill switch 闩锁:stop 后除豁免工具外全部 CONTROL_STOPPED(幂等,已停再 stop 不换 reason)。 */
class KillSwitch {
  #stopped = false;
  #stopReason = null;
  ensureRunning() {
    if (this.#stopped) {
      throw new BrokerError(
        `Computer control for this session is stopped${this.#stopReason ? ` (${this.#stopReason})` : ""}. Only request_access and stop_computer_control remain available; call stop_computer_control only to re-read the guard state.`,
        { code: "control_stopped" },
      );
    }
  }
  stop(reason) {
    if (!this.#stopped) {
      this.#stopped = true;
      this.#stopReason = typeof reason === "string" && reason ? reason : null;
    }
  }
  status() {
    return { stopped: this.#stopped, stop_reason: this.#stopReason };
  }
}

/**
 * 单控制器租约:同时仅一个会话可下发动作(R4)。观测/只读工具与 stop 不占租约
 * (helper 侧 admitControllerAction 同语义);冲突报 controller_busy(带 owner,retry:never)。
 */
class ControllerLease {
  #owner = null;
  async ensure({ toolName, sessionId }) {
    if (!MUTATING_TOOL_NAMES.has(toolName)) return;
    if (this.#owner && this.#owner.sessionId !== sessionId) {
      throw new BrokerError(
        `Computer Use controller is busy: owned by session ${this.#owner.sessionId}${this.#owner.turnId ? ` turn ${this.#owner.turnId}` : ""}. Do not retry automatically; only one session may drive the computer at a time.`,
        { code: "controller_busy", details: { owner: this.#owner } },
      );
    }
    this.#owner = { sessionId };
  }
  setTurn(sessionId, turnId) {
    if (this.#owner?.sessionId === sessionId && turnId) this.#owner = { sessionId, turnId };
  }
  release(sessionId) {
    if (this.#owner?.sessionId === sessionId) this.#owner = null;
  }
  get owner() {
    return this.#owner;
  }
}

/** settle 台账:同目标动作串行,mutating 后给 UI 一个 settle 窗口再放行下一个动作。 */
class ActionSettler {
  #tails = new Map();
  constructor(settleWindowMs = 0) {
    this.settleWindowMs = settleWindowMs;
  }
  async wait(key) {
    const tail = this.#tails.get(key);
    if (tail) await tail;
  }
  defer(key) {
    if (this.settleWindowMs <= 0) {
      this.#tails.delete(key);
      return;
    }
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    const timer = setTimeout(release, this.settleWindowMs);
    timer.unref?.();
    this.#tails.set(key, promise.finally(() => this.#tails.delete(key)));
  }
}

function settleTargetKey(appRef) {
  if (!appRef || typeof appRef !== "object") return "*";
  if (typeof appRef.pid === "number") return `pid:${appRef.pid}`;
  if (typeof appRef.bundle_id === "string" && appRef.bundle_id) {
    return `bundle:${appRef.bundle_id.toLowerCase()}`;
  }
  if (typeof appRef.name === "string" && appRef.name) return `name:${appRef.name}`;
  return "*";
}

function isBrokerUnavailableException(error) {
  return (
    error instanceof BrokerError &&
    (error.code === "broker_unavailable" ||
      error.code === "stale_socket" ||
      error.code === "unavailable")
  );
}

/**
 * createComputerUseRuntime:options.brokerSocketPath/env 覆盖解析;
 * ensureBrokerAvailable 在每次 broker 调用前执行(services 懒启动 Helper 的钩子);
 * refreshMarkerPath 为 broker 轮换 marker(存在即等待轮换结束)。
 */
export function createComputerUseRuntime(options = {}) {
  const env = options.env ?? process.env;
  const socketPath = options.brokerSocketPath ?? resolveBrokerSocketPath({ env });
  const sessions = new Map();
  const lease = new ControllerLease();
  const settler = new ActionSettler(
    typeof options.settleWindowMs === "number" ? options.settleWindowMs : 0,
  );
  let disposed = false;
  let refreshWait;

  const ensureFreshBroker = async () => {
    if (typeof options.ensureBrokerAvailable === "function") {
      await options.ensureBrokerAvailable();
    }
    if (!options.refreshMarkerPath) return;
    // 轮换 marker 在盘 = Helper 正在换代;等 marker 消失再发请求,避免撞 CUA_NOT_READY。
    try {
      await stat(options.refreshMarkerPath);
    } catch {
      return;
    }
    refreshWait ??= (async () => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          await stat(options.refreshMarkerPath);
        } catch {
          return;
        }
        if (Date.now() >= deadline) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })().finally(() => {
      refreshWait = undefined;
    });
    await refreshWait;
  };

  const sessionFor = (context) => {
    const sessionId = context?.sessionId ?? "anonymous";
    let session = sessions.get(sessionId);
    if (!session) {
      session = {
        store: new CuaToolSession(),
        killSwitch: new KillSwitch(),
        sessionKey: randomUUID(),
      };
      sessions.set(sessionId, session);
    }
    return session;
  };

  const callBroker = async (method, params, context, session, opts = {}) => {
    await ensureFreshBroker();
    return await callBrokerMethod({
      socketPath,
      method,
      params,
      timeoutMs: opts.timeoutMs,
      signal: context?.signal,
      connection: {
        client_type: "zcode_cua_mcp",
        workspace_key: context?.workspaceKey ?? "",
        session_id: context?.sessionId ?? "",
        thread_id: context?.turnId ?? "",
        connection_id: randomUUID(),
      },
    });
  };

  async function execute(input) {
    if (disposed) {
      return toolError("Computer Use runtime is disposed.", { code: "internal" });
    }
    const toolName = input?.toolName;
    const context = input?.context ?? {};
    // R3 桥/策略双拒:subagent 一律不可用,文案与桥侧逐字一致。
    if (context.runtimeScope === "subagent") return subagentUnavailableResult();
    if (typeof toolName !== "string" || !TOOL_NAME_SET.has(toolName)) {
      return toolError(`Unknown Computer Use tool: ${String(toolName)}`, { code: "internal" });
    }

    let args;
    try {
      args = parseToolArguments(toolName, input.arguments ?? {});
    } catch (error) {
      const message = error instanceof SchemaError ? error.message : String(error);
      return toolError(message, { code: "invalid_request", details: { action_sent: false } });
    }

    const session = sessionFor(context);
    if (typeof context.turnId === "string" && context.turnId) {
      lease.setTurn(context.sessionId, context.turnId);
    }

    // kill switch 门(豁免 request_access/stop)。
    if (!KILL_SWITCH_EXEMPT.has(toolName)) {
      try {
        session.killSwitch.ensureRunning();
      } catch (error) {
        return toolError(error.message, { code: "CONTROL_STOPPED" });
      }
    }

    // controllerLease 门(只读/观测不占;controller_* 控制命令绕过,helper 侧同)。
    try {
      await lease.ensure({ toolName, sessionId: context.sessionId ?? "anonymous" });
    } catch (error) {
      return toolError(error.message, {
        code: error instanceof BrokerError ? error.code : "controller_busy",
        details: error instanceof BrokerError ? error.details : undefined,
      });
    }

    const settleKey = settleTargetKey(args.app_ref);
    await settler.wait(settleKey);
    const handlers = createToolHandlers({
      callBroker: (method, params, opts) => callBroker(method, params, context, session, opts),
      session: session.store,
      platform: options.platform ?? process.platform,
      killSwitch: session.killSwitch,
      sessionKey: session.sessionKey,
    });

    let result;
    try {
      result = await handlers[toolName](args);
    } catch (error) {
      // broker 不可用 → CUA_NOT_READY 信封(possibly_sent 归一 broker_response_ambiguous)。
      if (isBrokerUnavailableException(error)) {
        return notReadyResult(
          notReadyPayloadForDelivery(error.details ?? {}, toolName),
        );
      }
      if (error instanceof SchemaError) {
        return toolError(error.message, { code: "invalid_request", details: { action_sent: false } });
      }
      return toolError(error instanceof Error ? error.message : String(error), {
        ...(typeof error?.code === "string" ? { code: error.code } : {}),
        ...(error?.details && typeof error.details === "object" ? { details: error.details } : {}),
      });
    }
    if (MUTATING_TOOL_NAMES.has(toolName) && result.isError !== true) {
      settler.defer(settleKey);
    }

    // app-associations meta(桥跳摘取目标应用身份)。
    const mode = APP_ASSOCIATION_MODE_BY_TOOL[toolName];
    if (mode === "none") return result;
    const apps =
      toolName === "list_apps"
        ? (result.structuredContent?.apps ?? [])
        : stateAppOf(result, session.store);
    return attachAppAssociationsMeta(result, mode, apps, options.platform ?? process.platform);
  }

  return {
    // 钉扎的 Helper 构建身份(B1-6):安装器同源执法;引用留在本闭包内保证 define 进产物。
    expectedHelperBuildId: resolveExpectedCuaHelperBuildId(),
    execute,
    async closeSession(closeContext) {
      const sessionId = closeContext?.sessionId ?? "anonymous";
      const session = sessions.get(sessionId);
      if (session) {
        session.store.clear();
        sessions.delete(sessionId);
      }
      lease.release(sessionId);
    },
    async dispose() {
      disposed = true;
      for (const session of sessions.values()) session.store.clear();
      sessions.clear();
      if (lease.owner) lease.release(lease.owner.sessionId);
    },
  };
}
