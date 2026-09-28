import type {
  AcknowledgedRelayProtocolLike,
  BridgeSpec,
  RpcFrame,
  RpcFrameAck,
} from "@zcode/shared/web-remote-control";
import { createAcknowledgedRelayProtocol } from "./acknowledgedRelayProtocol.js";
import {
  SharedHostError,
  startBridgeBytePump,
  type SharedHostAttachment,
  type WebRemoteControlHostAttachments,
} from "./hostAttachments.js";

// bridgeRegistry：workspace-bridge 生命周期簿记（借 Host attachment + per-bridge AcknowledgedRelayProtocol
// + 服务口字节泵）。绝不为手机新 spawn Host/Agent——attachment 来源只有窗口 Host 与既有 remote session。

export interface OpenBridgeParams {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
}

export interface OpenBridgeResult {
  bridge: BridgeSpec;
  attachment: SharedHostAttachment;
}

interface BridgeHandle {
  protocol: AcknowledgedRelayProtocolLike;
  attachment: SharedHostAttachment;
  stopPump: () => void;
}

export interface WebRemoteControlBridgeRegistry {
  open(params: OpenBridgeParams): OpenBridgeResult;
  closeAll(): void;
  /** relay data.payload 中的 rpc-frame/ack 按 bridgeSessionId 直通对应协议实例。 */
  acceptRawPayload(payload: { bridgeSessionId?: unknown }): boolean;
  forEachProtocol(visit: (protocol: AcknowledgedRelayProtocolLike) => void): void;
}

export function createWebRemoteControlBridgeRegistry(options: {
  hostAttachments: WebRemoteControlHostAttachments;
  /** 协议帧 → relay data 信封（返回 false=发送失败，帧留在重放缓冲）。 */
  sendFrameToRelay(frame: RpcFrame | RpcFrameAck): boolean;
  logger: {
    warn(...args: unknown[]): void;
    debug(...args: unknown[]): void;
  };
  windowId: number;
}): WebRemoteControlBridgeRegistry {
  const bridges = new Map<string, BridgeHandle>();

  function open(params: OpenBridgeParams): OpenBridgeResult {
    const existing = bridges.get(params.bridgeSessionId);
    if (existing) {
      existing.stopPump();
      existing.protocol.dispose();
      options.hostAttachments.detach(existing.attachment);
      bridges.delete(params.bridgeSessionId);
    }
    const attachment = params.remoteSessionId
      ? options.hostAttachments.openRemote({
          windowId: options.windowId,
          remoteSessionId: params.remoteSessionId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity ?? "",
          workspaceKey: params.workspaceKey,
        })
      : options.hostAttachments.openLocal(options.windowId);
    const protocol = createAcknowledgedRelayProtocol({
      bridgeSessionId: params.bridgeSessionId,
      ...(params.bridgeGeneration == null ? {} : { bridgeGeneration: params.bridgeGeneration }),
      ...(params.recoveryId ? { recoveryId: params.recoveryId } : {}),
      sendFrame: (frame) => options.sendFrameToRelay(frame),
    });
    protocol.onDegraded((relayFault) => {
      options.logger.warn("[web-remote-bridge] relay protocol fault", relayFault);
    });
    const stopPump = startBridgeBytePump({
      port: attachment.port,
      protocol,
      logger: options.logger,
    });
    bridges.set(params.bridgeSessionId, { protocol, attachment, stopPump });
    const identityFields = {
      bridgeSessionId: params.bridgeSessionId,
      ...(params.bridgeGeneration == null ? {} : { bridgeGeneration: params.bridgeGeneration }),
      ...(params.recoveryId ? { recoveryId: params.recoveryId } : {}),
      workspaceKey: params.workspaceKey,
      workspacePath: params.workspacePath,
      ...(params.initialTaskId ? { initialTaskId: params.initialTaskId } : {}),
    };
    const bridge: BridgeSpec = params.remoteSessionId
      ? {
          ...identityFields,
          kind: "remote",
          workspaceIdentity: params.workspaceIdentity ?? "",
          remoteSessionId: params.remoteSessionId,
        }
      : { ...identityFields, kind: "local" };
    return { bridge, attachment };
  }

  return {
    open,
    closeAll(): void {
      for (const bridge of bridges.values()) {
        bridge.stopPump();
        bridge.protocol.dispose();
        options.hostAttachments.detach(bridge.attachment);
      }
      bridges.clear();
    },
    acceptRawPayload(payload): boolean {
      const bridgeSessionId = payload.bridgeSessionId;
      const bridge = typeof bridgeSessionId === "string" ? bridges.get(bridgeSessionId) : undefined;
      if (!bridge) {
        options.logger.debug("[web-remote-bridge] rpc payload without bridge dropped");
        return false;
      }
      return bridge.protocol.acceptPayload(payload);
    },
    forEachProtocol(visit): void {
      for (const bridge of bridges.values()) {
        visit(bridge.protocol);
      }
    },
  };
}

export function assertBridgeHostAvailable(hasSession: boolean): void {
  if (!hasSession) {
    throw new SharedHostError("DESKTOP_HOST_MISSING", "远控会话未运行");
  }
}
