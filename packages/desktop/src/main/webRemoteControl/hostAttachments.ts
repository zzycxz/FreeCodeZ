import { randomUUID } from "node:crypto";
import { MessageChannelMain } from "electron";
import type { MessagePortMain, UtilityProcess as ElectronUtilityProcess } from "electron";
import { HostMessageTypes, type RemoteTarget } from "@zcode/shared";
import type { AcknowledgedRelayProtocolLike, FailureReason } from "@zcode/shared/web-remote-control";

// HostAttachments：手机经 attach-service-port 借用既有窗口 Host 的服务口，绝不为手机新 spawn Host/Agent
// （AGENTS.md 进程边界）。本地工作区取 windowHostProcessMap 已有窗口 Host；远程工作区走
// attachRemoteWorkspaceSessionHost（手机桥接专用缝）。错误码 SharedHostErrorCode 三值照附录A §7。

export type SharedHostErrorCode =
  | "DESKTOP_HOST_MISSING"
  | "REMOTE_SESSION_MISSING"
  | "REMOTE_WORKSPACE_IDENTITY_MISSING";

export class SharedHostError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SharedHostError";
    this.code = code;
  }
}

/** workspace-bridge 失败码 → FailureReason（附录A §7 mapWorkspaceBridgeFailureReason）。 */
export function mapWorkspaceBridgeFailureReason(code: string | undefined): FailureReason {
  switch (code) {
    case "DESKTOP_HOST_MISSING":
      return "desktop-disconnected";
    case "REMOTE_SESSION_MISSING":
    case "REMOTE_SESSION_WINDOW_MISMATCH":
    case "WINDOW_MISMATCH":
      return "workspace-closed";
    case "REMOTE_WORKSPACE_IDENTITY_MISSING":
    case "REMOTE_WORKSPACE_IDENTITY_MISMATCH":
    case "IDENTITY_MISSING":
    case "IDENTITY_MISMATCH":
      return "unsupported-action";
    case "KICKED":
      return "session-conflict";
    default:
      return "unexpected-error";
  }
}

export interface SharedHostAttachment {
  /** local: `desktop-host:<windowId>`；remote: `remote-session-host:<remoteSessionId>` */
  entryId: string;
  /** `shared-host-attachment-<n>` */
  attachmentId: string;
  process: ElectronUtilityProcess;
  port: MessagePortMain;
  remoteKind?: RemoteTarget["kind"];
}

export interface WebRemoteControlHostAttachments {
  openLocal(windowId: number): SharedHostAttachment;
  openRemote(params: {
    windowId: number;
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspaceKey: string;
  }): SharedHostAttachment;
  /** 幂等回收：Host 侧 detach + 关闭 MessagePort。 */
  detach(attachment: SharedHostAttachment): void;
}

export function createWebRemoteControlHostAttachments(options: {
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  attachRemoteWorkspaceSessionHost: (params: {
    windowId: number;
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspaceKey: string;
    clientMode: "web-remote-replayable";
  }) => {
    process: ElectronUtilityProcess;
    port: MessagePortMain;
    remoteKind: RemoteTarget["kind"];
  };
  createMessageChannel?: () => { port1: MessagePortMain; port2: MessagePortMain };
  logger: {
    warn(...args: unknown[]): void;
  };
}): WebRemoteControlHostAttachments {
  let attachmentSequence = 0;

  function nextAttachmentId(): string {
    attachmentSequence += 1;
    return `shared-host-attachment-${attachmentSequence}`;
  }

  function openLocal(windowId: number): SharedHostAttachment {
    const process = options.windowHostProcessMap.get(windowId);
    if (!process || process.pid == null) {
      throw new SharedHostError("DESKTOP_HOST_MISSING", `窗口 Local Host 不存在，windowId=${windowId}`);
    }
    const { port1, port2 } = options.createMessageChannel?.() ?? new MessageChannelMain();
    const attachmentId = nextAttachmentId();
    try {
      process.postMessage(
        {
          type: HostMessageTypes.AttachServicePort,
          requestId: randomUUID(),
          attachmentId,
          clientMode: "web-remote-replayable",
          scope: { kind: "local" },
        },
        [port2],
      );
    } catch (error) {
      port1.close();
      port2.close();
      throw new SharedHostError(
        "DESKTOP_HOST_MISSING",
        `attach-service-port 投递失败，windowId=${windowId}，${String(error)}`,
      );
    }
    return {
      entryId: `desktop-host:${windowId}`,
      attachmentId,
      process,
      port: port1,
    };
  }

  function openRemote(params: {
    windowId: number;
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspaceKey: string;
  }): SharedHostAttachment {
    if (!params.workspaceIdentity.trim() || !params.remoteSessionId.trim()) {
      throw new SharedHostError(
        "REMOTE_WORKSPACE_IDENTITY_MISSING",
        "远程 workspace 必须同时携带 workspaceIdentity 与 remoteSessionId",
      );
    }
    let attached: {
      process: ElectronUtilityProcess;
      port: MessagePortMain;
      remoteKind: RemoteTarget["kind"];
    };
    try {
      attached = options.attachRemoteWorkspaceSessionHost({
        ...params,
        clientMode: "web-remote-replayable",
      });
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      throw new SharedHostError(
        code || "REMOTE_SESSION_MISSING",
        error instanceof Error ? error.message : String(error),
      );
    }
    return {
      entryId: `remote-session-host:${params.remoteSessionId}`,
      attachmentId: nextAttachmentId(),
      process: attached.process,
      port: attached.port,
      remoteKind: attached.remoteKind,
    };
  }

  function detach(attachment: SharedHostAttachment): void {
    try {
      attachment.process.postMessage({
        type: HostMessageTypes.DetachServicePort,
        attachmentId: attachment.attachmentId,
      });
    } catch (error) {
      // Host 已退出时 detach 失败可恢复；端口关闭仍要继续。
      options.logger.warn("[web-remote-host] detach service port failed", {
        attachmentId: attachment.attachmentId,
        error,
      });
    }
    try {
      attachment.port.close();
    } catch {
      // 端口可能已被对端关闭。
    }
  }

  return { openLocal, openRemote, detach };
}

/**
 * Host 服务口 ↔ AcknowledgedRelayProtocol 的字节泵：port 上的二进制 chunk 经 rpc-frame
 * 分片承载 v4 字节流；回程重组消息按 chunk 回灌 port。返回 disposer（幂等）。
 */
export function startBridgeBytePump(params: {
  port: MessagePortMain;
  protocol: AcknowledgedRelayProtocolLike;
  logger: { warn(...args: unknown[]): void };
}): () => void {
  const toBytes = (data: unknown): Uint8Array | null => {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
  };
  const onPortMessage = (messageEvent: { data: unknown }) => {
    const bytes = toBytes(messageEvent.data);
    if (!bytes) {
      // 服务口只承载 §4.7 二进制 RPC 帧；非字节消息不是 v4 字节流的一部分。
      params.logger.warn("[web-remote-host] non-binary service port message dropped");
      return;
    }
    params.protocol.protocol.send(bytes);
  };
  const onProtocolMessage = params.protocol.onMessage((buffer) => {
    try {
      params.port.postMessage(Buffer.from(buffer));
    } catch {
      params.logger.warn("[web-remote-host] bridge message post to host failed");
    }
  });
  params.port.on("message", onPortMessage as (messageEvent: { data: unknown }) => void);
  // MessagePortMain 需要 start() 才会投递排队中的消息。
  params.port.start();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    onProtocolMessage.dispose();
    params.port.off("message", onPortMessage as (messageEvent: { data: unknown }) => void);
  };
}
