import { randomUUID } from "node:crypto";
import {
  WEB_REMOTE_CONTROL_LIMITS,
  isRawTransportCandidate,
  type AppMessage,
  type MobileDeviceInfo,
  type MobileViewState,
  type RemoteTaskListItem,
  type RemoteWorkspaceDescriptor,
  type WebRemoteControlContext,
  type WebRemoteControlStatus,
} from "@zcode/shared/web-remote-control";
import {
  createAppMessageRouter,
  type AppMessageRouter,
} from "./appMessageRouter.js";
import {
  assertBridgeHostAvailable,
  createWebRemoteControlBridgeRegistry,
  type WebRemoteControlBridgeRegistry,
} from "./bridgeRegistry.js";
import { createOutboundAppBuffer, type OutboundAppBuffer } from "./outboundAppBuffer.js";
import { buildWebRemoteControlStatus, idleWebRemoteControlStatus, isSameContext } from "./managerStatus.js";
import { buildWebRemoteControlPairingUrls } from "./pairing.js";
import {
  cancelStartToken,
  createStartToken,
  performManagerStart,
  type ManagerStartHooks,
} from "./managerStart.js";
import type {
  ActiveSession,
  StartToken,
  WebRemoteControlManager,
  WebRemoteControlManagerDeps,
} from "./managerTypes.js";

// Manager：移动端远控唯一状态所有者（per webContents.id 隔离）。
// 状态机 idle→starting→running(等待手机)→connecting(正在连接手机)→active(手机已连接) + error/kicked 旁路；
// start 幂等（同 ctx 复用 session，或 mobileConnected 且有 session）；start 一次性授权 token TTL 30s；
// QR-ready 等待 30s；手机断开宽限 3s；出站缓冲经 outboundAppBuffer（50 条/5s 丢弃）。

export type {
  ActiveSession,
  StartToken,
  WebRemoteControlManager,
  WebRemoteControlManagerDeps,
  WebRemoteControlManagerLogger,
} from "./managerTypes.js";

const OUTBOUND_BUFFER_MAX = WEB_REMOTE_CONTROL_LIMITS.outboundBufferMaxEntries;
const OUTBOUND_BUFFER_WINDOW_MS = WEB_REMOTE_CONTROL_LIMITS.outboundBufferWindowMs;
const START_TOKEN_TTL_MS = WEB_REMOTE_CONTROL_LIMITS.startAuthTokenTtlMs;
const MOBILE_DISCONNECT_GRACE_MS = WEB_REMOTE_CONTROL_LIMITS.mobileDisconnectGraceMs;

export function createWebRemoteControlManager(
  deps: WebRemoteControlManagerDeps,
): WebRemoteControlManager {
  const now = deps.now ?? (() => Date.now());
  const windowControlSessionId = randomUUID();
  let runtimeStatus: WebRemoteControlStatus["status"] = "idle";
  let session: ActiveSession | null = null;
  let mobileConnected = false;
  let mobileViewState: MobileViewState | undefined;
  let mobileDeviceInfo: MobileDeviceInfo | undefined;
  let failure: NonNullable<WebRemoteControlStatus["failure"]> | undefined;
  let errorText: string | undefined;
  let workspaces: RemoteWorkspaceDescriptor[] = [];
  let tasks: RemoteTaskListItem[] = [];
  let startToken: StartToken | null = null;
  let startInFlight: Promise<WebRemoteControlStatus | { status: "cancelled" }> | null = null;
  let disconnectGraceTimer: NodeJS.Timeout | null = null;
  let disposed = false;

  const outbox: OutboundAppBuffer = createOutboundAppBuffer({
    maxEntries: OUTBOUND_BUFFER_MAX,
    windowMs: OUTBOUND_BUFFER_WINDOW_MS,
    now,
    logger: deps.logger,
  });
  const bridges: WebRemoteControlBridgeRegistry = createWebRemoteControlBridgeRegistry({
    hostAttachments: deps.hostAttachments,
    sendFrameToRelay: (frame) => session?.transport.sendData(frame) ?? false,
    logger: deps.logger,
    windowId: deps.webContentsId,
  });

  function buildStatus(): WebRemoteControlStatus {
    const active = session;
    return buildWebRemoteControlStatus({
      status: runtimeStatus,
      sessionId: active?.sessionId ?? "",
      windowControlSessionId,
      mobileConnected,
      ...(mobileViewState ? { mobileViewState } : {}),
      ...(mobileDeviceInfo ? { mobileDeviceInfo } : {}),
      qrUrl: active?.qrUrl ?? "",
      connectUrl: active?.connectUrl ?? "",
      ...(active ? { context: active.context } : {}),
      ...(errorText ? { error: errorText } : {}),
      ...(failure ? { failure } : {}),
    });
  }

  function pushStatus(): void {
    if (!disposed) deps.sendStatus(buildStatus());
  }

  function setStatus(next: WebRemoteControlStatus["status"]): void {
    if (runtimeStatus === next) return;
    runtimeStatus = next;
    pushStatus();
  }

  function setFailure(next: NonNullable<WebRemoteControlStatus["failure"]> | null): void {
    failure = next ?? undefined;
    errorText = next?.message;
    pushStatus();
  }

  function sendAppMessage(message: AppMessage): void {
    if (disposed || !session) return;
    outbox.offer(message, (candidate) => session?.transport.sendData(candidate) ?? false);
  }

  function teardownRuntime(notifyMobile: boolean): void {
    if (disconnectGraceTimer) {
      clearTimeout(disconnectGraceTimer);
      disconnectGraceTimer = null;
    }
    outbox.clear();
    mobileConnected = false;
    const current = session;
    session = null;
    if (!current) return;
    if (notifyMobile) {
      // 停止/换代前先尽力通知手机，失败不阻塞 teardown。
      current.transport.sendData({
        zcode_type: "app-error",
        reason: "desktop-disconnected",
        error: "desktop stopped web remote control",
      } satisfies AppMessage);
    }
    bridges.closeAll();
    current.router.dispose();
    current.transport.stop();
    if (current.relayLease && deps.embeddedRelay) {
      // 内嵌 relay 租约随会话释放；release 同步递减计数，计数归零才异步关停。
      void deps.embeddedRelay.release().catch((error: unknown) => {
        deps.logger.warn("[web-remote-manager] embedded relay release failed", error);
      });
    }
  }

  function markMobileMessage(): void {
    if (disconnectGraceTimer) {
      clearTimeout(disconnectGraceTimer);
      disconnectGraceTimer = null;
    }
    if (!mobileConnected) {
      mobileConnected = true;
      pushStatus();
    }
    if (runtimeStatus === "connecting" || runtimeStatus === "running") {
      setStatus("active");
    }
  }

  function handlePairStatusWaiting(): void {
    if (disconnectGraceTimer || !session) return;
    // 手机断开宽限 3s：期间消息到达即取消降级，超时回落 running(等待手机)。
    disconnectGraceTimer = setTimeout(() => {
      disconnectGraceTimer = null;
      mobileConnected = false;
      if (runtimeStatus === "active" || runtimeStatus === "connecting") {
        setStatus("running");
      } else {
        pushStatus();
      }
    }, MOBILE_DISCONNECT_GRACE_MS);
    disconnectGraceTimer.unref?.();
  }

  function handleRelayData(payload: unknown): void {
    if (!session) return;
    if (isRawTransportCandidate(payload)) {
      bridges.acceptRawPayload(payload as { bridgeSessionId?: unknown });
      return;
    }
    session.router.handle(payload);
  }

  function createSessionRouter(): AppMessageRouter {
    return createAppMessageRouter({
      logger: deps.logger,
      send: sendAppMessage,
      getWorkspaces: () => workspaces,
      getTasks: () => tasks,
      getWindowControlSessionId: () => windowControlSessionId,
      getDesktopAppVersion: () => deps.appVersion,
      getMobileViewState: () => mobileViewState,
      openBridge: (params) => {
        assertBridgeHostAvailable(session != null);
        return bridges.open(params);
      },
      requestWorkspaceReconnect: deps.requestWorkspaceReconnect,
      platformHandlers: deps.platformHandlers,
      onMobileViewState: (viewState, deviceInfo) => {
        mobileViewState = viewState;
        if (deviceInfo) mobileDeviceInfo = deviceInfo;
        // 任务行「手机正在操作此任务」绿标的数据源。
        pushStatus();
      },
      onMobileMessage: markMobileMessage,
    });
  }

  const startHooks: ManagerStartHooks = {
    now,
    logger: deps.logger,
    pairing: deps.pairing,
    deviceMid: deps.deviceMid,
    deviceName: deps.deviceName,
    appVersion: deps.appVersion,
    ...(deps.resolveWsUrl ? { resolveWsUrl: deps.resolveWsUrl } : {}),
    acquireRelay: async () => {
      if (!deps.embeddedRelay) return null;
      return deps.embeddedRelay.acquire();
    },
    setStatus,
    setFailure,
    setErrorText: (text) => {
      errorText = text;
    },
    clearFailure: () => {
      failure = undefined;
      errorText = undefined;
      pushStatus();
    },
    handlePairStatusWaiting,
    handlePairStatusMatched: () => {
      if (runtimeStatus === "running") setStatus("connecting");
    },
    handleRelayData,
    handlePaired: () => {
      if (runtimeStatus === "running") setStatus("connecting");
      outbox.flush((candidate) => session?.transport.sendData(candidate) ?? false);
      bridges.forEachProtocol((protocol) => {
        protocol.replayUnacknowledged();
      });
    },
    handleRecoverableError: (message) => {
      deps.logger.warn("[web-remote-manager] relay recoverable error", message);
    },
    createSessionRouter,
    attachSession: (active) => {
      session = active;
    },
    isActiveSession: (active) => session === active,
    teardownRuntime,
    writeLastEnabledContext: (context) => deps.pairing.writeLastEnabledContext(context),
    writeAutoEnabled: (enabled) => deps.pairing.writeAutoEnabled(enabled),
    buildStatus,
    clearStartToken: () => {
      startToken = null;
    },
  };

  function cancelStart(): void {
    const token = startToken;
    startToken = null;
    cancelStartToken(token);
  }

  function beginStart(
    context: WebRemoteControlContext,
  ): Promise<WebRemoteControlStatus | { status: "cancelled" }> {
    cancelStart();
    // 一次性授权 token TTL 30s：过期/被换代的启动流程不能复活会话，返回 cancelled。
    startToken = createStartToken(now(), START_TOKEN_TTL_MS);
    runtimeStatus = "starting";
    pushStatus();
    const token = startToken;
    const run = performManagerStart(startHooks, context, token);
    startInFlight = run.finally(() => {
      if (startInFlight === run) startInFlight = null;
    });
    return startInFlight;
  }

  async function start(
    context: WebRemoteControlContext,
  ): Promise<WebRemoteControlStatus | { status: "cancelled" }> {
    if (disposed) return idleWebRemoteControlStatus(windowControlSessionId);
    // 幂等：同 ctx 复用 session；mobileConnected 且有 session 一律复用（不打断手机在途操作）。
    if (session) {
      if (mobileConnected || isSameContext(session.context, context)) {
        return buildStatus();
      }
      teardownRuntime(false);
    }
    if (startInFlight) {
      return startInFlight;
    }
    return beginStart(context);
  }

  async function refreshPairing(
    context: WebRemoteControlContext,
  ): Promise<WebRemoteControlStatus | { status: "cancelled" }> {
    if (disposed) return idleWebRemoteControlStatus(windowControlSessionId);
    // rotate：停 runtime → 清 sid+passHash → 重新注册。旧链接立即失效（session-not-found）；
    // deviceSid 全局一份，rotate 对其他窗口的远控会话同样换代（spec W4，官方同款副作用）。
    cancelStart();
    teardownRuntime(true);
    await deps.pairing.rotate();
    return beginStart(context);
  }

  async function stop(): Promise<void> {
    cancelStart();
    teardownRuntime(true);
    await deps.pairing.clearLastEnabledContext();
    // 停止=显式退出常驻可达（spec §1.10）：重启后不再自动开启，直到用户再次开启。
    await deps.pairing.writeAutoEnabled(false);
    failure = undefined;
    errorText = undefined;
    setStatus("idle");
  }

  async function handleWindowClosed(): Promise<void> {
    cancelStart();
    teardownRuntime(true);
    runtimeStatus = "idle";
    disposed = true;
    // 关窗不清 lastEnabledContext：重启后由「全局一次性 + 首个匹配窗口独占」恢复（验收 8）。
  }

  /** 钉选网卡变更后重建配对 URL（sid/hash 不轮换，旧码在旧 IP 仍存续时继续有效）。 */
  async function rebuildPairingUrls(): Promise<WebRemoteControlStatus> {
    const current = session;
    if (!current || !current.relayLease || !deps.embeddedRelay) return buildStatus();
    const relay = await deps.embeddedRelay.peek();
    if (!relay?.embedded) return buildStatus();
    const credentials = await deps.pairing.ensureCredentials();
    const deviceSid = current.transport.getDeviceSid() ?? credentials.deviceSid;
    if (!deviceSid) return buildStatus();
    const urls = buildWebRemoteControlPairingUrls({
      deviceSid,
      passHash: credentials.passHash,
      deviceMid: deps.deviceMid,
      deviceName: deps.deviceName,
      appVersion: deps.appVersion,
      now,
      pageBaseUrl: relay.pageBaseUrl,
    });
    current.qrUrl = urls.qrUrl;
    current.connectUrl = urls.connectUrl;
    pushStatus();
    return buildStatus();
  }

  return {
    start,
    refreshPairing,
    stop,
    rebuildPairingUrls,
    getStatus: () => (disposed ? idleWebRemoteControlStatus(windowControlSessionId) : buildStatus()),
    syncWorkspaces: (next) => {
      workspaces = next;
      if (session && mobileConnected) {
        // 窗口集合变化实时推送手机（workspace-list-updated），数据面与 bootstrap 同源。
        sendAppMessage({
          zcode_type: "workspace-list-updated",
          result: session.router.buildWorkspaceListResult(),
        });
      }
    },
    syncTasks: (next) => {
      tasks = next;
    },
    handleWindowClosed,
  };
}
