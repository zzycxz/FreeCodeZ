// bot /reconnect 的 RemoteWorkspaceGate 实现（附录D §3.2-1 双链路重连的 host 段）。
// isConnected 以 windowRemoteConnectionRegistry 的真实远程连接状态机判定 workspaceIdentity 是否在线，
// 供 bots 授权链的远端拦截 4 文案（remoteDisconnected/remoteDisconnectedStatus/
// remoteWorkspaceSelectedDisconnected）与 /reconnect 的 already-connected 判定消费。
// reconnect 经 parentPort 发 BotRemoteWorkspaceReconnectRequest（通知侧 A3）委托 main→renderer 执行重连，
// 官方 ensureConnected 语义 60s 超时；结果按 requestId 配对回填（请求侧 E3）。
import { randomUUID } from "node:crypto";
import { HostResponseTypes } from "@zcode/shared";

export interface BotRemoteWorkspaceGateContext {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** 与 packages/services RemoteWorkspaceGate 同形（结构兼容），另带 main 重连结果分派入口。 */
export interface BotRemoteWorkspaceGate {
  isConnected(params: BotRemoteWorkspaceGateContext): Promise<boolean>;
  reconnect(params: BotRemoteWorkspaceGateContext): Promise<{ ok: boolean; message?: string }>;
  /** host 消息泵分派 main 回传的 BotRemoteWorkspaceReconnectResult。 */
  handleReconnectResult(result: { requestId: string; ok: boolean; error?: string }): void;
}

export interface BotRemoteWorkspaceGateLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

interface RemoteSessionConnectionSnapshotLike {
  state: string;
  sourceAvailability: string;
}

interface PendingReconnect {
  resolve: (result: { ok: boolean; message?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 官方 ensureConnected 超时（附录D §3.2-1）：60s 未收到 main 重连结果即按失败回文案。 */
const BOT_REMOTE_WORKSPACE_RECONNECT_TIMEOUT_MS = 60_000;

export function createBotRemoteWorkspaceGate(options: {
  postToMain: (message: unknown) => void;
  findSessionForWorkspace: (
    params: BotRemoteWorkspaceGateContext,
  ) => RemoteSessionConnectionSnapshotLike | null;
  logger: BotRemoteWorkspaceGateLogger;
  timeoutMs?: number;
}): BotRemoteWorkspaceGate {
  const timeoutMs = options.timeoutMs ?? BOT_REMOTE_WORKSPACE_RECONNECT_TIMEOUT_MS;
  const pending = new Map<string, PendingReconnect>();

  return {
    async isConnected(params) {
      // findSessionForWorkspace 在同 identity 命中多个 logical session 时会抛错；
      // 这里 fail-closed 视为未连接，交由 bots 管道回 remoteDisconnected 系文案。
      try {
        const session = options.findSessionForWorkspace(params);
        return session?.state === "online" && session.sourceAvailability === "online";
      } catch (error) {
        options.logger.warn(
          "[bot-remote-workspace-gate] 远程连接态查询失败，视为未连接",
          params.workspaceIdentity ?? params.workspacePath,
          error,
        );
        return false;
      }
    },

    async reconnect(params) {
      const requestId = randomUUID();
      return new Promise<{ ok: boolean; message?: string }>((resolve) => {
        const timer = setTimeout(() => {
          if (!pending.delete(requestId)) {
            return;
          }
          options.logger.warn(
            "[bot-remote-workspace-gate] 等待 main 重连结果超时",
            params.workspaceIdentity ?? params.workspacePath,
          );
          resolve({ ok: false, message: `等待重连结果超时（${Math.round(timeoutMs / 1000)}s）` });
        }, timeoutMs);
        timer.unref?.();
        pending.set(requestId, { resolve, timer });
        try {
          options.postToMain({
            type: HostResponseTypes.BotRemoteWorkspaceReconnectRequest,
            requestId,
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          });
        } catch (error) {
          const entry = pending.get(requestId);
          if (entry) {
            pending.delete(requestId);
            clearTimeout(entry.timer);
            resolve({
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      });
    },

    handleReconnectResult(result) {
      const entry = pending.get(result.requestId);
      if (!entry) {
        return;
      }
      pending.delete(result.requestId);
      clearTimeout(entry.timer);
      entry.resolve(
        result.ok
          ? { ok: true }
          : { ok: false, message: result.error ?? "unknown" },
      );
    },
  };
}
