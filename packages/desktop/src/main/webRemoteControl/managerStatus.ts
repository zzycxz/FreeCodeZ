import type {
  MobileDeviceInfo,
  MobileViewState,
  WebRemoteControlContext,
  WebRemoteControlStatus,
} from "@zcode/shared/web-remote-control";

// WebRemoteControlStatus 只读投影（附录A §7 buildRuntimeStatus）的纯构建函数。
// 状态机：idle→starting→running(等待手机)→connecting(正在连接手机)→active(手机已连接)；error/kicked 旁路。

export interface WebRemoteControlStatusState {
  status: WebRemoteControlStatus["status"];
  sessionId: string;
  windowControlSessionId: string;
  mobileConnected: boolean;
  mobileViewState?: MobileViewState;
  mobileDeviceInfo?: MobileDeviceInfo;
  qrUrl: string;
  connectUrl: string;
  context?: WebRemoteControlContext;
  error?: string;
  failure?: NonNullable<WebRemoteControlStatus["failure"]>;
}

export function buildWebRemoteControlStatus(
  state: WebRemoteControlStatusState,
): WebRemoteControlStatus {
  const context = state.context;
  return {
    status: state.status,
    sessionId: state.sessionId,
    windowControlSessionId: state.windowControlSessionId,
    mobileConnected: state.mobileConnected,
    ...(state.mobileViewState ? { mobileViewState: state.mobileViewState } : {}),
    ...(state.mobileDeviceInfo ? { mobileDeviceInfo: state.mobileDeviceInfo } : {}),
    qrUrl: state.qrUrl,
    connectUrl: state.connectUrl,
    workspacePath: context?.workspacePath ?? "",
    ...(context?.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
    ...(context?.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
    ...(context?.initialTaskId ? { initialTaskId: context.initialTaskId } : {}),
    ...(state.error ? { error: state.error } : {}),
    ...(state.failure ? { failure: state.failure } : {}),
  };
}

/** 无窗 / 已停止时的空闲投影。 */
export function idleWebRemoteControlStatus(windowControlSessionId: string): WebRemoteControlStatus {
  return {
    status: "idle",
    sessionId: "",
    windowControlSessionId,
    mobileConnected: false,
    qrUrl: "",
    connectUrl: "",
    workspacePath: "",
  };
}

/** start 幂等判据：同 workspacePath/identity/remoteSessionId 视为同 ctx（spec §2）。 */
export function isSameContext(a: WebRemoteControlContext, b: WebRemoteControlContext): boolean {
  return (
    a.workspacePath === b.workspacePath &&
    (a.workspaceIdentity ?? "") === (b.workspaceIdentity ?? "") &&
    (a.remoteSessionId ?? "") === (b.remoteSessionId ?? "")
  );
}
