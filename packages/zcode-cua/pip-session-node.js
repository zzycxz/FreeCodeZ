// FreeCodeZ fork(电脑控制能力补位 B2):PiP 会话事件客户端真实现。
// 握手 zcode-cua-pip-session-v2:{protocolVersion:2, runtimeId:"zcode-cua-pip-session-v2"},
// 不符 → version_mismatch(R12 连接期);事件判别联合见 ./pip-session.d.ts。
import { callBrokerMethod, resolveBrokerSocketPath } from "./broker.js";

export const PIP_SESSION_PROTOCOL_VERSION = 2;
export const PIP_SESSION_RUNTIME_ID = "zcode-cua-pip-session-v2";

export function createPipSessionClient(options = {}) {
  const socketPath = options.socketPath ?? resolveBrokerSocketPath({ env: options.env });
  const timeoutMs = options.timeoutMs ?? 5_000;
  const reconnectAttempts = options.reconnectAttempts ?? 0;
  const reconnectDelayMs = options.reconnectDelayMs ?? 250;
  let enabled = false;
  let connected = false;

  const call = async (method, params, attemptsLeft = reconnectAttempts) => {
    try {
      return await callBrokerMethod({
        socketPath,
        method,
        params,
        timeoutMs,
        connection: { client_type: "zcode_cua_mcp", role: "presentation" },
      });
    } catch (error) {
      if (attemptsLeft > 0) {
        await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs));
        return await call(method, params, attemptsLeft - 1);
      }
      options.onDiagnostic?.({
        code: error?.code ?? "internal",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  return {
    get enabled() {
      return enabled;
    },
    async connect() {
      const result = await call("pip_session_handshake", {
        protocolVersion: PIP_SESSION_PROTOCOL_VERSION,
        runtimeId: PIP_SESSION_RUNTIME_ID,
      });
      connected = result?.ready === true;
      enabled = connected;
      if (!connected) {
        throw new Error("PiP session handshake was not accepted by the Helper");
      }
    },
    async send(event) {
      if (!connected) return { applied: false, reason: "not_connected" };
      const result = await call("pip_session_event", { event });
      return {
        applied: result?.applied === true,
        ...(typeof result?.reason === "string" ? { reason: result.reason } : {}),
      };
    },
    close() {
      connected = false;
      enabled = false;
    },
  };
}
