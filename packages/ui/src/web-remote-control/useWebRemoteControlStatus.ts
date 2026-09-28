/**
 * 移动端远程控制 renderer 只读投影。
 *
 * 状态唯一写入方是 desktop main 的 WebRemoteControlManager；renderer 只有两条读取通道：
 * 1s 轮询 `getWebRemoteControlStatus` + `onWebRemoteControlStatusChanged` 推送。
 * 两条通道汇入同一份模块级快照，全字段判等防抖，避免同值重渲染（附录C §1.1/§1.2）。
 */
import { useSyncExternalStore } from "react";
import type {
  RemoteTaskListItem,
  RemoteWorkspaceDescriptor,
  WebRemoteControlContext,
  WebRemoteControlStatus,
} from "@zcode/shared/web-remote-control";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

/**
 * renderer 侧投影：`getWebRemoteControlStatus` 无窗口时只回 `{status:'idle'}`，字段整体可选。
 * `deviceToken/expiresAt` 是配对凭据引用（附录A §7），shared 的展示 schema 未带，这里补齐判等字段。
 */
export type WebRemoteControlStatusSnapshot = Partial<WebRemoteControlStatus> & {
  status: WebRemoteControlStatus["status"];
  deviceToken?: string;
  expiresAt?: number;
};

export interface WebRemoteControlReconnectRequest {
  requestId: string;
  workspaceKey: string;
}

export type WebRemoteControlReconnectResult = { success: boolean; error?: string };

export interface WebRemoteControlPairNic {
  ip: string;
  name: string;
  label: string;
  isDefault: boolean;
  reason?: string;
}

export interface WebRemoteControlPairNicsResult {
  nics: WebRemoteControlPairNic[];
  pinned: string;
}

export type WebRemoteControlSetPairAddressResult = {
  address: string;
  valid: boolean;
  error?: string;
};

/**
 * preload 面（另一任务按同名契约实现）。ui 单独 typecheck 拿不到 desktop renderer 注入的
 * `window.zcode` 声明，这里按消费面收窄结构形状，不再依赖共享包扩展 IPlatformService。
 */
export interface WebRemoteControlBridge {
  startWebRemoteControl(
    context: WebRemoteControlContext,
  ): Promise<WebRemoteControlStatusSnapshot | { status: "cancelled" }>;
  refreshWebRemoteControlPairing(
    context: WebRemoteControlContext,
  ): Promise<WebRemoteControlStatusSnapshot | { status: "cancelled" }>;
  stopWebRemoteControl(): Promise<void>;
  getWebRemoteControlStatus(): Promise<WebRemoteControlStatusSnapshot>;
  /** 配对网卡（spec §5 LAN 地址选取）；旧 preload 无此面时弹窗隐藏网卡行。 */
  listWebRemoteControlPairNics?(): Promise<WebRemoteControlPairNicsResult>;
  setWebRemoteControlPairAddress?(address: string): Promise<WebRemoteControlSetPairAddressResult>;
  /** 远程访问开放能力（spec §1.11 自建中继 origin）；旧 preload 无此面时弹窗隐藏该行。 */
  getWebRemoteControlExternalRelay?(): Promise<string>;
  setWebRemoteControlExternalRelay?(
    url: string,
  ): Promise<WebRemoteControlSetPairAddressResult>;
  onWebRemoteControlStatusChanged(
    callback: (status: WebRemoteControlStatusSnapshot) => void,
  ): () => void;
  onWebRemoteControlReconnectWorkspace(
    callback: (
      request: WebRemoteControlReconnectRequest,
    ) => WebRemoteControlReconnectResult | Promise<WebRemoteControlReconnectResult>,
  ): () => void;
  syncWebRemoteControlWorkspaces(workspaces: RemoteWorkspaceDescriptor[]): void;
  syncWebRemoteControlTasks(tasks: RemoteTaskListItem[]): void;
}

type WebRemoteControlWindow = Window & { zcode?: Partial<WebRemoteControlBridge> };

export function getWebRemoteControlBridge(): WebRemoteControlBridge | null {
  if (typeof window === "undefined") {
    return null;
  }
  const bridge = (window as WebRemoteControlWindow).zcode;
  if (!bridge?.startWebRemoteControl || !bridge.getWebRemoteControlStatus) {
    return null;
  }
  return bridge as WebRemoteControlBridge;
}

const IDLE_STATUS: WebRemoteControlStatusSnapshot = { status: "idle" };

/** 全字段判等（附录C §1.2 `fin` + 手机 viewState，绿标依赖它不被防抖吃掉）。 */
export function webRemoteControlStatusEquals(
  left: WebRemoteControlStatusSnapshot | undefined,
  right: WebRemoteControlStatusSnapshot | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.status === right.status &&
    left.sessionId === right.sessionId &&
    left.windowControlSessionId === right.windowControlSessionId &&
    left.deviceToken === right.deviceToken &&
    left.expiresAt === right.expiresAt &&
    left.mobileConnected === right.mobileConnected &&
    left.mobileDeviceInfo?.updatedAt === right.mobileDeviceInfo?.updatedAt &&
    left.mobileDeviceInfo?.userAgent === right.mobileDeviceInfo?.userAgent &&
    left.mobileDeviceInfo?.browserPlatform === right.mobileDeviceInfo?.browserPlatform &&
    left.mobileDeviceInfo?.name === right.mobileDeviceInfo?.name &&
    left.mobileDeviceInfo?.viewport?.width === right.mobileDeviceInfo?.viewport?.width &&
    left.mobileDeviceInfo?.viewport?.height === right.mobileDeviceInfo?.viewport?.height &&
    left.mobileViewState?.activeWorkspaceKey === right.mobileViewState?.activeWorkspaceKey &&
    left.mobileViewState?.activeTaskId === right.mobileViewState?.activeTaskId &&
    left.mobileViewState?.updatedAt === right.mobileViewState?.updatedAt &&
    left.qrUrl === right.qrUrl &&
    left.connectUrl === right.connectUrl &&
    left.workspacePath === right.workspacePath &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.remoteSessionId === right.remoteSessionId &&
    left.initialTaskId === right.initialTaskId &&
    left.error === right.error &&
    left.failure?.reason === right.failure?.reason &&
    left.failure?.message === right.failure?.message
  );
}

function resolveSessionId(status: WebRemoteControlStatusSnapshot): string | undefined {
  return status.windowControlSessionId ?? status.sessionId;
}

/**
 * 已有会话是否属于同一 workspace 上下文（可复用，不重复 start）。
 * workspaceKey 统一走 `workspaceIdentity?.trim() || workspacePath`，远程身份不能仅按路径匹配。
 */
export function isSameContextSession(
  status: WebRemoteControlStatusSnapshot,
  context: Pick<WebRemoteControlContext, "workspacePath" | "workspaceIdentity" | "remoteSessionId">,
): boolean {
  if (status.status === "idle" || status.status === "error") {
    return false;
  }
  const statusWorkspacePath = status.workspacePath?.trim();
  if (!statusWorkspacePath) {
    return false;
  }
  const targetKey = buildTaskWorkspaceKey(context.workspacePath, context.workspaceIdentity);
  const statusKey = buildTaskWorkspaceKey(statusWorkspacePath, status.workspaceIdentity);
  if (statusKey !== targetKey) {
    return false;
  }
  const targetSessionId = context.remoteSessionId?.trim() || undefined;
  const statusSessionId = status.remoteSessionId?.trim() || undefined;
  if (statusSessionId !== targetSessionId) {
    return false;
  }
  return Boolean(resolveSessionId(status));
}

/** 手机已连上的会话同样复用，避免弹窗每次打开都打断在线手机。 */
export function isMobileConnectedSession(status: WebRemoteControlStatusSnapshot): boolean {
  if (status.status === "idle" || status.status === "error") {
    return false;
  }
  return Boolean(status.mobileConnected && resolveSessionId(status));
}

// ── 模块级共享投影：多个消费方（触发按钮/弹窗/任务行）共用一份轮询与订阅 ──

const listeners = new Set<() => void>();
let snapshot: WebRemoteControlStatusSnapshot = IDLE_STATUS;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let disposeStatusSubscription: (() => void) | null = null;

function publishStatus(next: WebRemoteControlStatusSnapshot): void {
  if (webRemoteControlStatusEquals(snapshot, next)) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

/** 弹窗启动/刷新后的返回值直接入投影，避免等下一次轮询。 */
export function publishWebRemoteControlStatus(next: WebRemoteControlStatusSnapshot): void {
  publishStatus(next);
}

async function pollStatus(): Promise<void> {
  const bridge = getWebRemoteControlBridge();
  if (!bridge) {
    return;
  }
  try {
    publishStatus(await bridge.getWebRemoteControlStatus());
  } catch {
    // 轮询失败只丢弃这一次读数；启动失败的报错由调用方显式提示。
  }
}

function startSharedPolling(): void {
  if (pollTimer !== null) {
    return;
  }
  const bridge = getWebRemoteControlBridge();
  if (!bridge) {
    return;
  }
  void pollStatus();
  pollTimer = setInterval(() => {
    void pollStatus();
  }, 1000);
  disposeStatusSubscription = bridge.onWebRemoteControlStatusChanged((status) => {
    publishStatus(status);
  });
}

function stopSharedPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  disposeStatusSubscription?.();
  disposeStatusSubscription = null;
}

function subscribeStatus(listener: () => void): () => void {
  listeners.add(listener);
  startSharedPolling();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopSharedPolling();
    }
  };
}

function getStatusSnapshot(): WebRemoteControlStatusSnapshot {
  return snapshot;
}

/** 1s 轮询 + status-changed 订阅的共享投影 hook。 */
export function useWebRemoteControlStatus(): WebRemoteControlStatusSnapshot {
  return useSyncExternalStore(subscribeStatus, getStatusSnapshot, getStatusSnapshot);
}

/**
 * 手机 viewState 命中的任务（spec §1.9 绿标）。
 * 命中 key = `activeWorkspaceKey:activeTaskId`，与任务行的 `workspaceKey:taskId` 对齐。
 */
export function buildMobileActiveTaskKey(
  status: WebRemoteControlStatusSnapshot | undefined,
): string | null {
  const viewState = status?.mobileViewState;
  if (!status?.mobileConnected || !viewState?.activeWorkspaceKey || !viewState.activeTaskId) {
    return null;
  }
  return `${viewState.activeWorkspaceKey}:${viewState.activeTaskId}`;
}

export function useMobileActiveTask(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  taskId: string,
): boolean {
  const status = useWebRemoteControlStatus();
  const activeKey = buildMobileActiveTaskKey(status);
  if (!activeKey) {
    return false;
  }
  return activeKey === `${buildTaskWorkspaceKey(workspacePath, workspaceIdentity)}:${taskId}`;
}

/** 列表行渲染循环里不能逐行调 hook；行内用这个 key 与 `workspaceKey:taskId` 比对。 */
export function useMobileActiveTaskKey(): string | null {
  return buildMobileActiveTaskKey(useWebRemoteControlStatus());
}
