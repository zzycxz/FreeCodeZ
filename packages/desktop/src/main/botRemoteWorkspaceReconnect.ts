// bot /reconnect 的 main 段执行器（附录D §3.2-1 双链路重连）。
// 官方链由 main 直接执行重连；FreeCodeZ 的远程连接执行器在 renderer（useRemoteWorkspaceHistory
// 的 runReconnectRemoteWorkspaceEntry），因此这里委托窗口 renderer 重连：
//   host BotRemoteWorkspaceReconnectRequest（通知侧 A3）
//     → 复用 WebRemoteControlReconnectWorkspace requestId 配对通道派发 renderer（60s 超时，官方 ensureConnected）
//     → 回 host BotRemoteWorkspaceReconnectResult（请求侧 E3）
//     → 成功后广播 zcode:bot-remote-workspace-reconnected（main→全部 renderer，Root 刷状态投影，官方同款）。
import { BrowserWindow } from "electron";
import type { UtilityProcess } from "electron";
import {
  HostMessageTypes,
  HostResponseTypes,
  PlatformChannels,
  hostResponseMessageSchema,
  type BotRemoteWorkspaceReconnectedEvent,
} from "@zcode/shared";
import {
  createRendererReconnectBridge,
  type RendererReconnectBridge,
} from "./webRemoteControl/webRemoteControlIpc.js";

export interface BotRemoteWorkspaceReconnectLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface BotRemoteWorkspaceReconnectExecutor {
  /** 挂接一个 window Host 子进程的消息泵（bot 重连请求只来自该 host 所属窗口）。 */
  attach(child: UtilityProcess, params: { webContentsId: number }): void;
  dispose(): void;
}

/** 官方 ensureConnected 超时（附录D §3.2-1）：60s 内 renderer 未完成重连即按失败回 host。 */
const BOT_REMOTE_WORKSPACE_RECONNECT_TIMEOUT_MS = 60_000;

type RendererReconnectOutcome = { success: boolean; error?: string };

function broadcastBotRemoteWorkspaceReconnected(event: BotRemoteWorkspaceReconnectedEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      continue;
    }
    win.webContents.send(PlatformChannels.BotRemoteWorkspaceReconnected, event);
  }
}

export function createBotRemoteWorkspaceReconnectExecutor(options: {
  logger: BotRemoteWorkspaceReconnectLogger;
  /** 测试/装配注入；缺省自建一个 WRC 通道配对桥（与手机链桥并存，requestId 互不冲突）。 */
  reconnectBridge?: RendererReconnectBridge;
  timeoutMs?: number;
  broadcast?: (event: BotRemoteWorkspaceReconnectedEvent) => void;
}): BotRemoteWorkspaceReconnectExecutor {
  const timeoutMs = options.timeoutMs ?? BOT_REMOTE_WORKSPACE_RECONNECT_TIMEOUT_MS;
  const broadcast = options.broadcast ?? broadcastBotRemoteWorkspaceReconnected;
  const bridge = options.reconnectBridge ?? createRendererReconnectBridge(options.logger);
  const attached = new Set<{ child: UtilityProcess; listener: (message: unknown) => void }>();
  let disposed = false;

  async function runReconnect(
    child: UtilityProcess,
    webContentsId: number,
    request: {
      requestId: string;
      workspacePath: string;
      workspaceIdentity?: string;
    },
  ): Promise<void> {
    const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<RendererReconnectOutcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({ success: false, error: `重连超时（${Math.round(timeoutMs / 1000)}s）` });
      }, timeoutMs);
      timer.unref?.();
    });
    const delegated = bridge
      .request(webContentsId, request.requestId, workspaceKey)
      .catch(
        (error: unknown): RendererReconnectOutcome => ({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    const outcome = await Promise.race([delegated, timeout]);
    if (timer) {
      clearTimeout(timer);
    }
    try {
      child.postMessage({
        type: HostMessageTypes.BotRemoteWorkspaceReconnectResult,
        requestId: request.requestId,
        ok: outcome.success,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
    } catch (error) {
      // host 已退出时结果无法回传；gate 侧同样有 60s 超时兜底，这里只记录。
      options.logger.warn("[bot-remote-reconnect] 回传重连结果失败", error);
      return;
    }
    if (outcome.success) {
      options.logger.info(
        "[bot-remote-reconnect] 远端 workspace 重连成功，广播 bot-remote-workspace-reconnected",
        workspaceKey,
      );
      broadcast({
        workspacePath: request.workspacePath,
        ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
      });
    } else {
      options.logger.warn("[bot-remote-reconnect] 远端 workspace 重连失败", workspaceKey, outcome.error);
    }
  }

  return {
    attach(child, params) {
      const listener = (message: unknown): void => {
        if (disposed) {
          return;
        }
        const parsed = hostResponseMessageSchema.safeParse(message);
        if (!parsed.success) {
          return;
        }
        if (parsed.data.type !== HostResponseTypes.BotRemoteWorkspaceReconnectRequest) {
          return;
        }
        void runReconnect(child, params.webContentsId, parsed.data);
      };
      const entry = { child, listener };
      attached.add(entry);
      child.on("message", entry.listener);
      child.once("exit", () => {
        attached.delete(entry);
      });
    },
    dispose() {
      disposed = true;
      for (const { child, listener } of attached) {
        child.off("message", listener);
      }
      attached.clear();
      bridge.dispose();
    },
  };
}
