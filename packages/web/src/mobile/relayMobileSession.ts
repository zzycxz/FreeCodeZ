import {
  connectRelayMobileTransport,
  connectViaProtocol,
  createRelayBridgeProtocol,
  type RelayMobileBridgeChannel,
  type RelayMobileTransportState,
} from "@zcode/client";
import type { IServiceAccessor } from "@zcode/services";
import {
  appMessageSchema,
  type AppMessage,
  type BootstrapResult,
  type FailureReason,
  type MobileDeviceInfo,
  type MobileViewState,
  type PlatformMethod,
  type WorkspaceListResult,
} from "@zcode/shared/web-remote-control";
import type {
  MobileBridgeConnection,
  MobileDeviceIdentity,
  MobileLinkFailure,
  MobileLinkState,
  MobileRemoteSession,
} from "@zcode/ui/mobile";

// 手机侧 AppMessage 会话控制器：bootstrap/workspace-list/bridge/reconnect/platform 的
// request-response 关联 + workspace-list-updated 推送 + mobile-view-state-update 上报。
// workspace-bridge-ready 后用 relay rpc-frame 桥（AcknowledgedRelayProtocol 镜像）建
// ChannelClient/RemoteServiceAccess —— 与 packages/web 完全同层的服务面。

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type PendingKind = "bootstrap" | "list" | "bridge" | "reconnect" | "platform";

interface PendingRequest {
  kind: PendingKind;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export interface RelayMobileSessionOptions {
  wsUrl: string;
  sid: string;
  hash: string;
  name: string;
  appVersion: string;
  requestTimeoutMs?: number;
  /** 测试注入:透传给底层 relay transport 的 WebSocket 实现。 */
  webSocketImpl?: typeof WebSocket;
}

/** 会话句柄：MobileRemoteSession 契约 + 页面卸载释放。 */
export interface RelayMobileSessionHandle extends MobileRemoteSession {
  dispose(): void;
}

/** 结构化失败（与 ui 的 toLinkFailure 约定一致：{reason,message} 可直接透传）。 */
class MobileSessionFailure extends Error implements MobileLinkFailure {
  readonly reason: FailureReason;

  constructor(reason: FailureReason, message: string) {
    super(message);
    this.name = "MobileSessionFailure";
    this.reason = reason;
  }
}

export function createRelayMobileSession(options: RelayMobileSessionOptions): RelayMobileSessionHandle {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const transport = connectRelayMobileTransport({
    wsUrl: options.wsUrl,
    sid: options.sid,
    hash: options.hash,
    ...(options.webSocketImpl ? { WebSocketImpl: options.webSocketImpl } : {}),
  });
  const identity: MobileDeviceIdentity = { name: options.name, appVersion: options.appVersion };

  const pending = new Map<string, PendingRequest>();
  const linkListeners = new Set<(state: MobileLinkState) => void>();
  const listListeners = new Set<(result: WorkspaceListResult) => void>();
  let requestSeq = 0;
  let appFailure: MobileLinkFailure | null = null;
  let transportState: RelayMobileTransportState = transport.state;
  let currentBridge: {
    channel: RelayMobileBridgeChannel;
    services: IServiceAccessor;
    protocol: ReturnType<typeof createRelayBridgeProtocol>;
  } | null = null;

  function currentLinkState(): MobileLinkState {
    return {
      phase: transportState.phase,
      ...(transportState.pairStatus ? { pairStatus: transportState.pairStatus } : {}),
      failure: transportState.failure ?? appFailure ?? undefined,
    };
  }

  function emitLinkState(): void {
    const state = currentLinkState();
    for (const listener of Array.from(linkListeners)) {
      try {
        listener(state);
      } catch {
        // 监听器异常不得影响会话状态机。
      }
    }
  }

  function nextRequestId(): string {
    requestSeq += 1;
    return `mobile-${Date.now().toString(36)}-${requestSeq}`;
  }

  function sendAppMessage(message: AppMessage): boolean {
    return transport.send(message);
  }

  function resolvePending(requestId: unknown, kind: PendingKind, value: unknown): void {
    if (typeof requestId !== "string") return;
    const entry = pending.get(requestId);
    if (!entry || entry.kind !== kind) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(value);
  }

  function failPending(requestId: unknown, failure: MobileLinkFailure): void {
    if (typeof requestId !== "string") return;
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.reject(new MobileSessionFailure(failure.reason, failure.message));
  }

  function request(
    kind: PendingKind,
    build: (requestId: string) => AppMessage,
    timeoutReason: FailureReason,
  ): Promise<unknown> {
    const requestId = nextRequestId();
    return new Promise((resolve, reject) => {
      // 传输未就绪时的补发订阅：页面挂载先于 WS open 是常态竞态（真机首屏 bootstrap
      // 曾必现 "relay transport not connected" 且失败后无人重试，任务列表永远为空），
      // 这里等待 phase=paired 补发而非立即失败；超时计时器继续兜底。
      let readySub: { dispose(): void } | null = null;
      const disposeReadySub = (): void => {
        readySub?.dispose();
        readySub = null;
      };
      const timer = setTimeout(() => {
        disposeReadySub();
        pending.delete(requestId);
        reject(new MobileSessionFailure(timeoutReason, `${kind} timeout`));
      }, requestTimeoutMs);
      pending.set(requestId, { kind, timer, resolve, reject });
      const message = build(requestId);
      if (!sendAppMessage(message)) {
        readySub = transport.onStateChange((state) => {
          if (state.phase === "paired") {
            disposeReadySub();
            sendAppMessage(message);
            return;
          }
          if (
            state.phase === "session-conflict" ||
            state.phase === "invalid-connection" ||
            state.phase === "relay-error" ||
            state.phase === "stopped"
          ) {
            disposeReadySub();
            failPending(
              requestId,
              state.failure ?? { reason: "relay-unavailable", message: "relay transport not connected" },
            );
          }
        });
        // 订阅前 transport 可能已回到 paired（send 失败只是 readyState 的瞬时窗口）。
        if (transport.state.phase === "paired") {
          disposeReadySub();
          sendAppMessage(message);
        }
      }
    });
  }

  function openBridgeConnection(message: {
    bridgeSessionId: string;
    bridgeGeneration?: number;
    recoveryId?: string;
    bridge: MobileBridgeConnection["bridge"];
  }): MobileBridgeConnection {
    const identityFields = {
      bridgeSessionId: message.bridgeSessionId,
      ...(message.bridgeGeneration == null ? {} : { bridgeGeneration: message.bridgeGeneration }),
      ...(message.recoveryId == null ? {} : { recoveryId: message.recoveryId }),
    };
    const channel = transport.openBridge(identityFields);
    // 协议修复（2026-09-28）：桥两端统一 MessagePort 语义。桌面 Host attachment 口在
    // attach 时立即下发 ChannelServer Initialize 握手；此前手机侧用 SocketProtocol 分帧，
    // 6 字节握手永远凑不齐 13 字节帧头，ChannelClient 的 whenInitialized 永不 resolve，
    // 订阅/发送等全部 RPC 请求排队不发——手机会话页 snapshot 到不了，输入框永久禁用。
    const protocol = createRelayBridgeProtocol(channel);
    const services = connectViaProtocol(protocol);
    currentBridge = { channel, protocol, services };
    return {
      bridge: message.bridge,
      services,
      dispose: () => {
        protocol.disconnect();
        channel.close();
        if (currentBridge?.channel === channel) currentBridge = null;
      },
    };
  }

  function closeBridge(): void {
    if (!currentBridge) return;
    currentBridge.protocol.disconnect();
    currentBridge.channel.close();
    currentBridge = null;
  }

  const payloadSub = transport.onPayload((payload) => {
    const parsed = appMessageSchema.safeParse(payload);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.zcode_type) {
      case "bootstrap-response":
        resolvePending(message.requestId, "bootstrap", message.result);
        return;
      case "workspace-list-response":
        resolvePending(message.requestId, "list", message.result);
        return;
      case "workspace-list-updated": {
        for (const listener of Array.from(listListeners)) {
          try {
            listener(message.result);
          } catch {
            // 忽略监听器异常
          }
        }
        return;
      }
      case "workspace-bridge-ready":
        resolvePending(
          message.requestId,
          "bridge",
          openBridgeConnection({
            bridgeSessionId: message.bridgeSessionId,
            ...(message.bridgeGeneration == null ? {} : { bridgeGeneration: message.bridgeGeneration }),
            ...(message.recoveryId == null ? {} : { recoveryId: message.recoveryId }),
            bridge: message.bridge,
          }),
        );
        return;
      case "workspace-bridge-error":
        failPending(message.requestId, { reason: message.reason, message: message.error });
        return;
      case "workspace-reconnect-response":
        resolvePending(message.requestId, "reconnect", {
          success: message.success,
          ...(message.error ? { error: message.error } : {}),
        });
        return;
      case "platform-response":
        if (message.success) {
          resolvePending(message.requestId, "platform", message.result);
        } else {
          failPending(message.requestId, {
            reason: "unexpected-error",
            message: message.error ?? String(message.method),
          });
        }
        return;
      case "app-error": {
        // app-error 是手机侧失败语义入口（desktop-disconnected 等 11 reason，spec §3）。
        appFailure = { reason: message.reason, message: message.error };
        failPending(message.requestId ?? null, appFailure);
        emitLinkState();
        return;
      }
      default:
        return;
    }
  });

  const linkSub = transport.onStateChange((state: RelayMobileTransportState) => {
    transportState = state;
    emitLinkState();
  });

  return {
    get link(): MobileLinkState {
      return currentLinkState();
    },
    onLinkStateChange(callback) {
      linkListeners.add(callback);
      return {
        dispose: () => {
          linkListeners.delete(callback);
        },
      };
    },
    bootstrap(): Promise<BootstrapResult> {
      return request(
        "bootstrap",
        (requestId) => ({ zcode_type: "bootstrap-request", requestId }),
        "desktop-bootstrap-timeout",
      ) as Promise<BootstrapResult>;
    },
    listWorkspaces(): Promise<WorkspaceListResult> {
      return request(
        "list",
        (requestId) => ({ zcode_type: "workspace-list-request", requestId }),
        "desktop-bootstrap-timeout",
      ) as Promise<WorkspaceListResult>;
    },
    onWorkspaceListUpdated(callback) {
      listListeners.add(callback);
      return {
        dispose: () => {
          listListeners.delete(callback);
        },
      };
    },
    openWorkspaceBridge(params) {
      closeBridge();
      return request(
        "bridge",
        (requestId) => ({
          zcode_type: "workspace-bridge-open",
          requestId,
          bridgeSessionId: `mobile-bridge-${requestId}`,
          workspaceKey: params.workspaceKey,
          ...(params.taskId ? { taskId: params.taskId } : {}),
        }),
        "connection-recovery-timeout",
      ) as Promise<MobileBridgeConnection>;
    },
    closeWorkspaceBridge(): void {
      closeBridge();
    },
    reconnectWorkspace(workspaceKey) {
      return request(
        "reconnect",
        (requestId) => ({ zcode_type: "workspace-reconnect-request", requestId, workspaceKey }),
        "connection-recovery-timeout",
      ) as Promise<{ success: boolean; error?: string }>;
    },
    updateViewState(viewState: MobileViewState, deviceInfo?: MobileDeviceInfo): void {
      sendAppMessage({
        zcode_type: "mobile-view-state-update",
        viewState,
        ...(deviceInfo
          ? { deviceInfo: { ...deviceInfo, name: identity.name, version: identity.appVersion } }
          : {}),
      });
    },
    requestPlatform<T = unknown>(method: PlatformMethod, args?: unknown): Promise<T> {
      return request(
        "platform",
        (requestId) => ({
          zcode_type: "platform-request",
          requestId,
          method,
          ...(args === undefined ? {} : { args }),
        }),
        "unexpected-error",
      ) as Promise<T>;
    },
    getDeviceIdentity(): MobileDeviceIdentity {
      return identity;
    },
    dispose(): void {
      // MobileRemoteSession 接口之外的释放入口（页面卸载时调用）。
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new MobileSessionFailure("unexpected-error", "session disposed"));
      }
      pending.clear();
      payloadSub.dispose();
      linkSub.dispose();
      closeBridge();
      transport.dispose();
    },
  };
}
