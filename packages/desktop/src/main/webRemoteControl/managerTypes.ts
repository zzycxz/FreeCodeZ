import type {
  RemoteTaskListItem,
  RemoteWorkspaceDescriptor,
  WebRemoteControlContext,
  WebRemoteControlStatus,
} from "@zcode/shared/web-remote-control";
import type { AppMessageRouter, WebRemoteControlPlatformHandlers } from "./appMessageRouter.js";
import type { RelayTransport } from "./relayTransport.js";
import type { RelayPairingStore } from "./pairing.js";
import type { WebRemoteControlHostAttachments } from "./hostAttachments.js";
import type { EmbeddedRelayController, EmbeddedRelayEndpoints } from "./embeddedRelay.js";

// Manager 对外与内部会话类型（与附录A §7 WebRemoteControlStatus/StartResult 对齐）。

export interface WebRemoteControlManagerLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface WebRemoteControlManagerDeps {
  webContentsId: number;
  logger: WebRemoteControlManagerLogger;
  pairing: RelayPairingStore;
  hostAttachments: WebRemoteControlHostAttachments;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  platformHandlers: WebRemoteControlPlatformHandlers;
  requestWorkspaceReconnect(
    requestId: string,
    workspaceKey: string,
  ): Promise<{ success: boolean; error?: string }>;
  sendStatus(status: WebRemoteControlStatus): void;
  resolveWsUrl?: () => string;
  /** 内嵌 LAN relay 控制器（spec §5）：缺省时按 env/默认端点连接（外部自建模式）。 */
  embeddedRelay?: EmbeddedRelayController;
  now?: () => number;
}

export interface WebRemoteControlManager {
  start(context: WebRemoteControlContext): Promise<WebRemoteControlStatus | { status: "cancelled" }>;
  refreshPairing(
    context: WebRemoteControlContext,
  ): Promise<WebRemoteControlStatus | { status: "cancelled" }>;
  /** 钉选网卡变更后重建 qrUrl/connectUrl（不轮换凭据）。 */
  rebuildPairingUrls(): Promise<WebRemoteControlStatus>;
  stop(): Promise<void>;
  getStatus(): WebRemoteControlStatus;
  syncWorkspaces(workspaces: RemoteWorkspaceDescriptor[]): void;
  syncTasks(tasks: RemoteTaskListItem[]): void;
  /** 窗口关闭：发 app-error 后全量 teardown，保留 lastEnabledContext 供重启恢复。 */
  handleWindowClosed(): Promise<void>;
}

export interface ActiveSession {
  sessionId: string;
  context: WebRemoteControlContext;
  qrUrl: string;
  connectUrl: string;
  transport: RelayTransport;
  router: AppMessageRouter;
  /** 本会话持有内嵌 relay 的租约（外部模式为 false，teardown 时不释放）。 */
  relayLease: boolean;
}

/** performManagerStart 与 Manager 闭包之间的内嵌 relay 钩子。 */
export interface ManagerRelayLease {
  endpoints: EmbeddedRelayEndpoints;
}

export interface StartToken {
  expiresAt: number;
  cancelled: boolean;
  abortPromise: Promise<"aborted">;
  abort: () => void;
}
