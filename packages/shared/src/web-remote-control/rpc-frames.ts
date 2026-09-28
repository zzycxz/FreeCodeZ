import { z } from "zod";
import {
  RPC_FRAME_LIMITS,
  checksumCrc32Schema,
  seqPositiveSchema,
  transportIdSchema,
} from "./core.js";

// RPC 桥可靠层帧（附录A §3.1）：逻辑消息 ≤16MB 切 ≤64 片，物理帧硬限 1MB；
// messageSeq 批量 + 累计 ack + 重连重放未确认批次（AcknowledgedRelayProtocol 消费）。

export const rpcFrameSchema = z
  .object({
    zcode_type: z.literal("rpc-frame"),
    bridgeSessionId: transportIdSchema,
    bridgeGeneration: z.number().int().min(0).optional(),
    recoveryId: transportIdSchema.optional(),
    seq: seqPositiveSchema,
    messageSeq: seqPositiveSchema,
    fragmentIndex: z.number().int().min(0).max(RPC_FRAME_LIMITS.maxFragments - 1),
    fragmentCount: z.number().int().min(1).max(RPC_FRAME_LIMITS.maxFragments),
    messageBytes: z
      .number()
      .int()
      .min(1)
      .max(RPC_FRAME_LIMITS.maxMessageBytes),
    checksum: checksumCrc32Schema,
    dataBase64: z.string().min(4).max(RPC_FRAME_LIMITS.maxPhysicalFrameBytes),
  })
  .strict()
  .superRefine((frame, context) => {
    if (frame.fragmentIndex >= frame.fragmentCount) {
      context.addIssue({
        code: "custom",
        message: "fragmentIndex must be < fragmentCount",
        path: ["fragmentIndex"],
      });
    }
    if (frame.fragmentCount > frame.messageBytes) {
      context.addIssue({
        code: "custom",
        message: "fragmentCount must be <= messageBytes",
        path: ["fragmentCount"],
      });
    }
  });
export type RpcFrame = z.infer<typeof rpcFrameSchema>;

export const rpcFrameAckSchema = z
  .object({
    zcode_type: z.literal("rpc-frame-ack"),
    bridgeSessionId: transportIdSchema,
    bridgeGeneration: z.number().int().min(0).optional(),
    recoveryId: transportIdSchema.optional(),
    ackMessageSeq: seqPositiveSchema,
  })
  .strict();
export type RpcFrameAck = z.infer<typeof rpcFrameAckSchema>;

/** payload 身份三元组全等才接受（replay/ack 归属判定）。 */
export interface BridgeSessionIdentity {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
}

export function isSameBridgeIdentity(
  a: BridgeSessionIdentity,
  b: BridgeSessionIdentity,
): boolean {
  return (
    a.bridgeSessionId === b.bridgeSessionId &&
    (a.bridgeGeneration ?? 0) === (b.bridgeGeneration ?? 0) &&
    (a.recoveryId ?? "") === (b.recoveryId ?? "")
  );
}

export interface OutboundBatch {
  messageSeq: number;
  frames: RpcFrame[];
  outerBytes: number;
  queuedAt: number;
  nextFrameIndex: number;
}

/** AcknowledgedRelayProtocol 对外协议面（main 侧实现，供 relay 载荷路由消费）。 */
export interface AcknowledgedRelayProtocolLike {
  readonly protocol: {
    onMessage(callback: (buffer: Uint8Array) => void): { dispose(): void };
    send(buffer: Uint8Array): void;
    drain(): Promise<void>;
  };
  onMessage(callback: (buffer: Uint8Array) => void): { dispose(): void };
  onSaturated(callback: () => void): { dispose(): void };
  onDrained(callback: () => void): { dispose(): void };
  onDegraded(callback: (fault: import("./core.js").RelayFault) => void): { dispose(): void };
  readonly unacknowledgedBytes: number;
  getBridgeSessionId(): string;
  isDegraded(): boolean;
  markDegraded(reasonCode?: string): void;
  replayUnacknowledged(): boolean;
  acceptPayload(payload: unknown): boolean;
  flushPendingFrames(): boolean;
  dispose(): void;
}
