import type { ReactNode } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type {
  BootstrapResult,
  BridgeSpec,
  FailureReason,
  MobileDeviceInfo,
  MobileViewState,
  PlatformMethod,
  WorkspaceListResult,
} from "@zcode/shared/web-remote-control";

// 手机端会话面（AppMessage 数据面 + 桥服务面）的结构化契约。
// 实现在 packages/client（relayMobileTransport + RemoteServiceAccess）；ui 包不依赖 @zcode/client，
// 这里只声明 MobileShell 消费的窄接口，由 packages/web 入口完成具体接线（依赖倒置）。

export type MobileLinkPhase =
  | "connecting"
  | "waiting-pair"
  | "paired"
  | "reconnecting"
  | "session-conflict"
  | "invalid-connection"
  | "relay-error"
  | "stopped";

export interface MobileLinkFailure {
  reason: FailureReason;
  message: string;
}

export interface MobileLinkState {
  phase: MobileLinkPhase;
  pairStatus?: "waiting" | "matched";
  failure?: MobileLinkFailure;
}

/** workspace-bridge-ready 之后的会话桥：服务面与 packages/web 完全同层（RemoteServiceAccess）。 */
export interface MobileBridgeConnection {
  bridge: BridgeSpec;
  services: IServiceAccessor;
  dispose(): void;
}

export interface MobileDeviceIdentity {
  name: string;
  appVersion: string;
}

/** 右抽屉面板内容（官方为 side-pane tab 集合；FreeCodeZ 由宿主注入）。 */
export interface MobileSidePaneContent {
  title?: string;
  body?: ReactNode;
}

export interface MobileRemoteSession {
  readonly link: MobileLinkState;
  onLinkStateChange(callback: (state: MobileLinkState) => void): { dispose(): void };
  /** bootstrap-request：窗口集合工作区/任务快照。 */
  bootstrap(): Promise<BootstrapResult>;
  /** workspace-list-request：刷新快照。 */
  listWorkspaces(): Promise<WorkspaceListResult>;
  onWorkspaceListUpdated(callback: (result: WorkspaceListResult) => void): { dispose(): void };
  /** workspace-bridge-open → workspace-bridge-ready：借 Host attachment 起服务面。 */
  openWorkspaceBridge(params: {
    workspaceKey: string;
    taskId?: string;
  }): Promise<MobileBridgeConnection>;
  closeWorkspaceBridge(): void;
  /** workspace-reconnect-request：断连远程工作区重连（renderer 120s 等待语义在桌面侧）。 */
  reconnectWorkspace(workspaceKey: string): Promise<{ success: boolean; error?: string }>;
  /** mobile-view-state-update：桌面绿标数据源（activeWorkspaceKey:activeTaskId）。 */
  updateViewState(viewState: MobileViewState, deviceInfo?: MobileDeviceInfo): void;
  /** platform-request（7 方法白名单，附录A §2）。 */
  requestPlatform<T = unknown>(method: PlatformMethod, args?: unknown): Promise<T>;
  getDeviceIdentity(): MobileDeviceIdentity;
}
