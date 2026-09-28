import {
  ACK_RELAY_LIMITS,
  RPC_FRAME_LIMITS,
  TERMINAL_RELAY_FAULT_REASONS,
  isSameBridgeIdentity,
  rpcFrameAckSchema,
  rpcFrameSchema,
  type AcknowledgedRelayProtocolLike,
  type BridgeSessionIdentity,
  type OutboundBatch,
  type RelayFault,
  type RelayFaultReason,
  type RpcFrame,
  type RpcFrameAck,
} from "@zcode/shared/web-remote-control";
import {
  createRelayFrameAssembler,
  createRelayReplayBuffer,
  encodeMessageFrames,
  measureFrameBytesDefault,
} from "./relayFrameMirror.js";

// AcknowledgedRelayProtocol 手机侧对称镜像（附录A §3.2，与 desktop/acknowledgedRelayProtocol.ts 同语义）：
// messageSeq 批量 OutboundBatch、累计 ack 只增不减（futureAck 终态降级）、重连 replayUnacknowledged()
// 重放未确认批次、重放缓冲 8MB/45s 宽限、饱和 1MB/256KB 流控、分片 ≤64 片/逻辑消息 ≤16MB/物理帧 1MB。
// 编解码/重组/重放缓冲在 relayFrameMirror.ts（纯函数，可单测）。

export {
  base64ToBytes,
  bytesToBase64,
  crc32Hex,
  createRelayFrameAssembler,
  createRelayReplayBuffer,
  encodeMessageFrames,
  measureFrameBytesDefault,
  MAX_FRAGMENT_DATA_BYTES,
} from "./relayFrameMirror.js";
export type { EncodeMessageResult, RelayFrameAssemblerOptions } from "./relayFrameMirror.js";

export interface RelayAckMirrorOptions {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  /** false = 发送失败（帧保留在重放缓冲，等重连重放）。 */
  sendFrame(frame: RpcFrame | RpcFrameAck): boolean | Promise<boolean>;
  measureFrameBytes?(frame: RpcFrame | RpcFrameAck): number;
  saturationHighWaterMarkBytes?: number;
  saturationLowWaterMarkBytes?: number;
  replayBufferMaxBytes?: number;
  replayBufferGraceMs?: number;
  assemblyTimeoutMs?: number;
  now?(): number;
}

type Listener<T> = { callback: (value: T) => void };

function addListener<T>(set: Set<Listener<T>>, callback: (value: T) => void): { dispose(): void } {
  const listener: Listener<T> = { callback };
  set.add(listener);
  return {
    dispose: () => {
      set.delete(listener);
    },
  };
}

export function createRelayAckMirror(options: RelayAckMirrorOptions): AcknowledgedRelayProtocolLike {
  const identity: BridgeSessionIdentity = {
    bridgeSessionId: options.bridgeSessionId,
    bridgeGeneration: options.bridgeGeneration,
    recoveryId: options.recoveryId,
  };
  const now = options.now ?? (() => Date.now());
  const measureFrameBytes = options.measureFrameBytes ?? measureFrameBytesDefault;
  const saturationHigh = Math.min(
    options.saturationHighWaterMarkBytes ?? ACK_RELAY_LIMITS.saturationHighWaterMarkBytes,
    ACK_RELAY_LIMITS.saturationHighWaterMarkBytes,
  );
  const saturationLow = Math.min(
    options.saturationLowWaterMarkBytes ?? ACK_RELAY_LIMITS.saturationLowWaterMarkBytes,
    saturationHigh,
  );
  const replayBufferMaxBytes = Math.min(
    options.replayBufferMaxBytes ?? ACK_RELAY_LIMITS.replayBufferMaxBytes,
    ACK_RELAY_LIMITS.replayBufferMaxBytes,
  );
  const replayBufferGraceMs = Math.min(
    options.replayBufferGraceMs ?? ACK_RELAY_LIMITS.replayBufferGraceMs,
    ACK_RELAY_LIMITS.replayBufferGraceMs,
  );
  const assemblyTimeoutMs = Math.min(
    options.assemblyTimeoutMs ?? ACK_RELAY_LIMITS.assemblyTimeoutMs,
    ACK_RELAY_LIMITS.assemblyTimeoutMs,
  );

  const messageListeners = new Set<Listener<Uint8Array>>();
  const saturatedListeners = new Set<Listener<void>>();
  const drainedListeners = new Set<Listener<void>>();
  const degradedListeners = new Set<Listener<RelayFault>>();
  const drainWaiters: Array<() => void> = [];
  const replayBuffer = createRelayReplayBuffer({ maxBytes: replayBufferMaxBytes, now });

  let outboundMessageSeq = 0;
  let outboundFrameSeq = 0;
  let highestFullySentMessageSeq = 0;
  let highestAckMessageSeq = 0;
  let saturated = false;
  let degraded = false;
  let disposed = false;
  let inboundAckCursor = 0;
  const deliveredPending = new Set<number>();

  function emit<T>(set: Set<Listener<T>>, value: T): void {
    for (const listener of Array.from(set)) {
      try {
        listener.callback(value);
      } catch {
        // 监听器异常不得影响协议状态机。
      }
    }
  }

  function fault(reasonCode: RelayFaultReason, messageSeq?: number): void {
    if (degraded || disposed) return;
    const terminal = TERMINAL_RELAY_FAULT_REASONS.has(reasonCode);
    emit(degradedListeners, {
      reasonCode,
      terminal,
      ...(messageSeq == null ? {} : { messageSeq }),
    });
    if (terminal) degraded = true;
  }

  function checkSaturation(): void {
    const unacknowledgedBytes = replayBuffer.unacknowledgedBytes();
    if (!saturated && unacknowledgedBytes > saturationHigh) {
      saturated = true;
      emit(saturatedListeners, undefined);
      return;
    }
    if (saturated && unacknowledgedBytes <= saturationLow) {
      saturated = false;
      emit(drainedListeners, undefined);
      while (drainWaiters.length > 0) drainWaiters.shift()?.();
    }
  }

  const assembler = createRelayFrameAssembler({
    identity,
    assemblyTimeoutMs,
    now,
    onDeliver: (bytes, messageSeq) => {
      for (const listener of Array.from(messageListeners)) {
        try {
          listener.callback(bytes);
        } catch {
          fault("remote.rpcFrame.deliveryFailed", messageSeq);
        }
      }
      // 累计 ack：连续交付段推进后一次性确认。
      deliveredPending.add(messageSeq);
      let advanced = false;
      while (deliveredPending.has(inboundAckCursor + 1)) {
        inboundAckCursor += 1;
        deliveredPending.delete(inboundAckCursor);
        advanced = true;
      }
      if (advanced) sendAck(inboundAckCursor);
    },
    onFault: (reason, messageSeq) => fault(reason, messageSeq),
  });

  function maintenance(): void {
    if (degraded || disposed) return;
    const overdue = replayBuffer.findOverdueBatch(now(), replayBufferGraceMs);
    if (overdue) {
      // 45s 宽限内未确认：对端 ack 停滞，重放缓冲不可信，终态降级。
      fault("remote.rpcFrame.ackGraceExceeded", overdue.messageSeq);
      return;
    }
    assembler.sweepStale();
  }

  function handleSendFailure(batch: OutboundBatch): void {
    if (degraded || disposed) return;
    fault("remote.rpcFrame.sendFailed", batch.messageSeq);
  }

  function flushPendingFrames(): boolean {
    if (degraded || disposed) return false;
    let ok = true;
    replayBuffer.forEachUnacked((batch) => {
      while (batch.nextFrameIndex < batch.frames.length) {
        const frame = batch.frames[batch.nextFrameIndex]!;
        let accepted: boolean | Promise<boolean>;
        try {
          accepted = options.sendFrame(frame);
        } catch {
          fault("remote.rpcFrame.sendFailed", batch.messageSeq);
          ok = false;
          return false;
        }
        if (typeof accepted === "boolean") {
          if (!accepted) {
            fault("remote.rpcFrame.sendFailed", batch.messageSeq);
            ok = false;
            return false;
          }
        } else {
          // 异步发送不阻塞 flush；失败按 sendFailed 上报，帧留在重放缓冲。
          void accepted.then(
            (sent) => {
              if (!sent) handleSendFailure(batch);
            },
            () => handleSendFailure(batch),
          );
        }
        batch.nextFrameIndex += 1;
      }
      if (batch.messageSeq > highestFullySentMessageSeq) {
        highestFullySentMessageSeq = batch.messageSeq;
      }
      return true;
    });
    return ok;
  }

  function sendBuffer(buffer: Uint8Array): void {
    if (degraded || disposed) return;
    const messageSeq = outboundMessageSeq + 1;
    const encoded = encodeMessageFrames({
      identity,
      bytes: buffer,
      messageSeq,
      startFrameSeq: outboundFrameSeq,
      measureFrameBytes,
    });
    if (!encoded.ok) {
      fault(encoded.reason, messageSeq);
      return;
    }
    const batch: OutboundBatch = {
      messageSeq,
      frames: encoded.frames,
      outerBytes: encoded.outerBytes,
      queuedAt: now(),
      nextFrameIndex: 0,
    };
    const enqueued = replayBuffer.enqueue(batch);
    if (!enqueued.ok) {
      fault(enqueued.reason, messageSeq);
      return;
    }
    // seq 计数器只在批次真正入队后提交，避免丢消息给累计 ack 制造永久空洞。
    outboundMessageSeq = messageSeq;
    outboundFrameSeq += encoded.frames.length;
    checkSaturation();
    flushPendingFrames();
    maintenance();
  }

  function replayUnacknowledged(): boolean {
    if (degraded || disposed) return false;
    const overdue = replayBuffer.findOverdueBatch(now(), replayBufferGraceMs);
    if (overdue) {
      fault("remote.rpcFrame.replayGraceExceeded", overdue.messageSeq);
      return false;
    }
    replayBuffer.forEachUnacked((batch) => {
      batch.nextFrameIndex = 0;
    });
    return flushPendingFrames();
  }

  function sendAck(ackMessageSeq: number): void {
    const ack: RpcFrameAck = {
      zcode_type: "rpc-frame-ack",
      bridgeSessionId: identity.bridgeSessionId,
      ...(identity.bridgeGeneration == null ? {} : { bridgeGeneration: identity.bridgeGeneration }),
      ...(identity.recoveryId == null ? {} : { recoveryId: identity.recoveryId }),
      ackMessageSeq,
    };
    if (measureFrameBytes(ack) > RPC_FRAME_LIMITS.maxPhysicalFrameBytes) {
      fault("remote.rpcFrame.outerMeterFailed", ackMessageSeq);
      return;
    }
    try {
      void options.sendFrame(ack);
    } catch {
      // ack 发送失败由重放/超时机制兜底，不在此降级。
    }
  }

  function handleAck(frame: RpcFrameAck): boolean {
    const ack = frame.ackMessageSeq;
    if (ack > highestFullySentMessageSeq) {
      // 对端确认了从未完整发出的 messageSeq：协议面已不可信，终态降级。
      fault("remote.rpcFrame.futureAck", ack);
      return true;
    }
    if (ack <= highestAckMessageSeq) return true; // 累计 ack 只增不减，旧 ack 静默忽略。
    highestAckMessageSeq = ack;
    replayBuffer.releaseThrough(ack);
    checkSaturation();
    maintenance();
    return true;
  }

  function acceptPayload(payload: unknown): boolean {
    if (degraded || disposed) return false;
    if (typeof payload !== "object" || payload === null) return false;
    const type = (payload as { zcode_type?: unknown }).zcode_type;
    if (type === "rpc-frame-ack") {
      const parsed = rpcFrameAckSchema.safeParse(payload);
      if (!parsed.success) {
        fault("remote.rpcFrame.invalidPayload");
        return false;
      }
      if (!isSameBridgeIdentity(identity, parsed.data)) return false;
      return handleAck(parsed.data);
    }
    if (type === "rpc-frame") {
      const parsed = rpcFrameSchema.safeParse(payload);
      if (!parsed.success) {
        fault("remote.rpcFrame.invalidPayload");
        return false;
      }
      return assembler.acceptFrame(parsed.data);
    }
    return false;
  }

  function drain(): Promise<void> {
    if (!saturated || degraded || disposed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      drainWaiters.push(resolve);
    });
  }

  const messageFacade = {
    onMessage(callback: (buffer: Uint8Array) => void): { dispose(): void } {
      return addListener(messageListeners, callback);
    },
    send(buffer: Uint8Array): void {
      sendBuffer(buffer);
    },
    drain,
  };

  return {
    protocol: messageFacade,
    onMessage: messageFacade.onMessage,
    onSaturated: (callback) => addListener(saturatedListeners, callback),
    onDrained: (callback) => addListener(drainedListeners, callback),
    onDegraded: (callback) => addListener(degradedListeners, callback),
    get unacknowledgedBytes(): number {
      return replayBuffer.unacknowledgedBytes();
    },
    getBridgeSessionId: () => identity.bridgeSessionId,
    isDegraded: () => degraded,
    markDegraded(reasonCode?: string): void {
      if (degraded || disposed) return;
      const code = (reasonCode ?? "remote.rpcFrame.manuallyDegraded") as RelayFaultReason;
      degraded = true;
      emit(degradedListeners, {
        reasonCode: code,
        terminal: TERMINAL_RELAY_FAULT_REASONS.has(code),
      });
    },
    replayUnacknowledged,
    acceptPayload,
    flushPendingFrames,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      replayBuffer.clear();
      assembler.reset();
      deliveredPending.clear();
      messageListeners.clear();
      saturatedListeners.clear();
      drainedListeners.clear();
      degradedListeners.clear();
      while (drainWaiters.length > 0) drainWaiters.shift()?.();
    },
  };
}
