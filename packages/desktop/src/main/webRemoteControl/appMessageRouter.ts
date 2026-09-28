import {
  appMessageSchema,
  bootstrapResultSchema,
  buildWorkspaceKey,
  platformMethodSchema,
  workspaceListResultSchema,
  type AppMessage,
  type MobileDeviceInfo,
  type MobileViewState,
  type PlatformMethod,
  type RemoteTaskListItem,
  type RemoteWorkspaceDescriptor,
  type WorkspaceListResult,
} from "@zcode/shared/web-remote-control";
import {
  SharedHostError,
  mapWorkspaceBridgeFailureReason,
} from "./hostAttachments.js";
import type { OpenBridgeParams, OpenBridgeResult } from "./bridgeRegistry.js";

// AppMessageRouter：relay data.payload 应用层消息路由（附录A §2）。
// bootstrap/workspace-list 只含当前窗口集合；workspace-bridge-open 硬校验 workspaceKey ∈ 窗口集合，
// 远程必须同时带 workspaceIdentity+remoteSessionId，越权 → unsupported-action；
// platform-request 仅 7 方法白名单；rpc-frame/ack 由 AcknowledgedRelayProtocol 直通（此处不分流）。

export type { OpenBridgeParams, OpenBridgeResult };

export type WebRemoteControlPlatformHandlers = Record<
  PlatformMethod,
  (args: unknown) => Promise<unknown>
>;

export interface AppMessageRouterLogger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface AppMessageRouterOptions {
  logger: AppMessageRouterLogger;
  /** 出站应用消息（manager 负责缓冲与发送）。 */
  send(message: AppMessage): void;
  getWorkspaces(): RemoteWorkspaceDescriptor[];
  getTasks(): RemoteTaskListItem[];
  getWindowControlSessionId(): string;
  getDesktopAppVersion(): string | undefined;
  getMobileViewState(): MobileViewState | undefined;
  openBridge(params: OpenBridgeParams): OpenBridgeResult;
  requestWorkspaceReconnect(
    requestId: string,
    workspaceKey: string,
  ): Promise<{ success: boolean; error?: string }>;
  platformHandlers: WebRemoteControlPlatformHandlers;
  onMobileViewState(viewState: MobileViewState, deviceInfo?: MobileDeviceInfo): void;
  onMobileMessage(): void;
}

export interface AppMessageRouter {
  handle(payload: unknown): void;
  /** 当前窗口集合投影（bootstrap / workspace-list 共用同一构造）。 */
  buildWorkspaceListResult(): WorkspaceListResult;
  dispose(): void;
}

export function createAppMessageRouter(options: AppMessageRouterOptions): AppMessageRouter {
  let disposed = false;

  function buildWorkspaceListResult(): WorkspaceListResult {
    const viewState = options.getMobileViewState();
    const result: WorkspaceListResult = {
      workspaces: options.getWorkspaces(),
      tasks: options.getTasks(),
      ...(viewState?.activeWorkspaceKey ? { activeWorkspaceKey: viewState.activeWorkspaceKey } : {}),
      ...(viewState?.activeTaskId ? { activeTaskId: viewState.activeTaskId } : {}),
    };
    return workspaceListResultSchema.parse(result);
  }

  function sendBridgeError(
    requestId: string,
    identity: { bridgeSessionId?: string; bridgeGeneration?: number; recoveryId?: string },
    code: string | undefined,
    error: string,
  ): void {
    options.send({
      zcode_type: "workspace-bridge-error",
      requestId,
      ...(identity.bridgeSessionId ? { bridgeSessionId: identity.bridgeSessionId } : {}),
      ...(identity.bridgeGeneration == null ? {} : { bridgeGeneration: identity.bridgeGeneration }),
      ...(identity.recoveryId ? { recoveryId: identity.recoveryId } : {}),
      reason: mapWorkspaceBridgeFailureReason(code),
      error,
    });
  }

  function handleBootstrapRequest(message: Extract<AppMessage, { zcode_type: "bootstrap-request" }>) {
    const mobileViewState = options.getMobileViewState();
    const result = bootstrapResultSchema.parse({
      windowControlSessionId: options.getWindowControlSessionId(),
      ...(options.getDesktopAppVersion()
        ? { desktopAppVersion: options.getDesktopAppVersion() }
        : {}),
      workspaces: options.getWorkspaces(),
      tasks: options.getTasks(),
      ...(mobileViewState ? { mobileViewState } : {}),
    });
    options.send({
      zcode_type: "bootstrap-response",
      requestId: message.requestId,
      success: true,
      result,
    });
  }

  function handleBridgeOpen(message: Extract<AppMessage, { zcode_type: "workspace-bridge-open" }>) {
    const identity = {
      bridgeSessionId: message.bridgeSessionId,
      bridgeGeneration: message.bridgeGeneration,
      recoveryId: message.recoveryId,
    };
    // 控制面硬校验：workspaceKey 必须属于当前窗口集合（数据面 bootstrap/list 同源）。
    const descriptor = options
      .getWorkspaces()
      .find(
        (workspace) =>
          buildWorkspaceKey(workspace.workspaceIdentity, workspace.workspacePath) ===
          message.workspaceKey,
      );
    if (!descriptor) {
      sendBridgeError(message.requestId, identity, undefined, "workspace 不在当前窗口集合内");
      return;
    }
    if (descriptor.kind === "remote") {
      if (!descriptor.workspaceIdentity?.trim() || !descriptor.remoteSessionId?.trim()) {
        sendBridgeError(
          message.requestId,
          identity,
          "REMOTE_WORKSPACE_IDENTITY_MISSING",
          "远程 workspace 缺少 workspaceIdentity/remoteSessionId",
        );
        return;
      }
    }
    try {
      const opened = options.openBridge({
        bridgeSessionId: message.bridgeSessionId,
        ...(message.bridgeGeneration == null ? {} : { bridgeGeneration: message.bridgeGeneration }),
        ...(message.recoveryId ? { recoveryId: message.recoveryId } : {}),
        workspaceKey: message.workspaceKey,
        workspacePath: descriptor.workspacePath,
        ...(descriptor.workspaceIdentity ? { workspaceIdentity: descriptor.workspaceIdentity } : {}),
        ...(descriptor.remoteSessionId ? { remoteSessionId: descriptor.remoteSessionId } : {}),
        ...(message.taskId ? { initialTaskId: message.taskId } : {}),
      });
      options.send({
        zcode_type: "workspace-bridge-ready",
        requestId: message.requestId,
        bridgeSessionId: message.bridgeSessionId,
        ...(message.bridgeGeneration == null ? {} : { bridgeGeneration: message.bridgeGeneration }),
        ...(message.recoveryId ? { recoveryId: message.recoveryId } : {}),
        bridge: opened.bridge,
      });
    } catch (error) {
      const code =
        error instanceof SharedHostError
          ? error.code
          : typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code ?? "")
            : undefined;
      sendBridgeError(
        message.requestId,
        identity,
        code,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function handleWorkspaceReconnectRequest(
    message: Extract<AppMessage, { zcode_type: "workspace-reconnect-request" }>,
  ): Promise<void> {
    let response: { success: boolean; error?: string };
    try {
      response = await options.requestWorkspaceReconnect(message.requestId, message.workspaceKey);
    } catch (error) {
      response = { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (disposed) return;
    options.send({
      zcode_type: "workspace-reconnect-response",
      requestId: message.requestId,
      workspaceKey: message.workspaceKey,
      success: response.success,
      ...(response.error ? { error: response.error } : {}),
    });
  }

  async function handlePlatformRequest(
    message: Extract<AppMessage, { zcode_type: "platform-request" }>,
  ): Promise<void> {
    const method = platformMethodSchema.parse(message.method);
    const handler = options.platformHandlers[method];
    try {
      const result = await handler(message.args);
      if (disposed) return;
      options.send({
        zcode_type: "platform-response",
        requestId: message.requestId,
        method,
        success: true,
        result,
      });
    } catch (error) {
      if (disposed) return;
      options.send({
        zcode_type: "platform-response",
        requestId: message.requestId,
        method,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function handle(payload: unknown): void {
    if (disposed) return;
    const parsed = appMessageSchema.safeParse(payload);
    if (!parsed.success) {
      options.logger.warn("[web-remote-router] unknown app message dropped");
      return;
    }
    const message = parsed.data;
    options.onMobileMessage();
    switch (message.zcode_type) {
      case "bootstrap-request":
        handleBootstrapRequest(message);
        return;
      case "workspace-list-request":
        options.send({
          zcode_type: "workspace-list-response",
          requestId: message.requestId,
          success: true,
          result: buildWorkspaceListResult(),
        });
        return;
      case "workspace-bridge-open":
        handleBridgeOpen(message);
        return;
      case "workspace-reconnect-request":
        void handleWorkspaceReconnectRequest(message);
        return;
      case "mobile-view-state-update":
        options.onMobileViewState(message.viewState, message.deviceInfo);
        return;
      case "platform-request":
        void handlePlatformRequest(message);
        return;
      case "bridge-degraded":
        options.logger.debug("[web-remote-router] bridge-degraded", message.reason);
        return;
      case "app-error":
        options.logger.debug("[web-remote-router] app-error", message.reason, message.error);
        return;
      case "mobile-diagnostic":
        options.logger.debug("[web-remote-router] mobile-diagnostic", message.event);
        return;
      case "telemetry-report":
        // FreeCodeZ 去遥测（spec W3）：telemetry-report 仅 debug 记录后丢弃。
        options.logger.debug("[web-remote-router] telemetry-report dropped");
        return;
      case "workspace-list-updated":
      case "workspace-bridge-ready":
      case "workspace-bridge-error":
      case "workspace-reconnect-response":
      case "platform-response":
      case "bootstrap-response":
        options.logger.debug("[web-remote-router] unexpected desktop-bound message ignored");
        return;
      default:
        return;
    }
  }

  return {
    handle,
    buildWorkspaceListResult,
    dispose(): void {
      disposed = true;
    },
  };
}
