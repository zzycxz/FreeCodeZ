import {
  RPC_FRAME_LIMITS,
  isSameBridgeIdentity,
  type BridgeSessionIdentity,
  type RelayFaultReason,
  type RpcFrame,
} from "@zcode/shared/web-remote-control";
import { BASE64_PATTERN, crc32Hex } from "./relayFrameCodec.js";

// rpc-frame 入站重组层（附录A §3.1/§3.2）：帧 seq 去重单调、payload 身份三元组全等才接受、
// base64/crc32/长度校验、按 messageSeq 重组 ≤64 片；重组超时静默回收（ack 由上层按序推进）。

export interface RpcFrameAssemblerOptions {
  identity: BridgeSessionIdentity;
  assemblyTimeoutMs: number;
  now(): number;
  onDeliver(bytes: Uint8Array, messageSeq: number): void;
  onFault(reason: RelayFaultReason, messageSeq: number): void;
}

export interface RpcFrameAssembler {
  acceptFrame(frame: RpcFrame): boolean;
  sweepStale(): void;
  reset(): void;
}

interface InboundAssembly {
  parts: Array<Uint8Array | undefined>;
  receivedCount: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: string;
  startedAt: number;
}

export function createRpcFrameAssembler(options: RpcFrameAssemblerOptions): RpcFrameAssembler {
  const assemblies = new Map<number, InboundAssembly>();
  let lastInboundFrameSeq = 0;

  function deliverAssembly(messageSeq: number, assembly: InboundAssembly, bytes: Uint8Array): void {
    assemblies.delete(messageSeq);
    if (bytes.byteLength !== assembly.messageBytes) {
      options.onFault("remote.rpcFrame.invalidPayload", messageSeq);
      return;
    }
    if (crc32Hex(bytes) !== assembly.checksum) {
      options.onFault("remote.rpcFrame.invalidPayload", messageSeq);
      return;
    }
    options.onDeliver(bytes, messageSeq);
  }

  function acceptFrame(frame: RpcFrame): boolean {
    if (frame.seq <= lastInboundFrameSeq) {
      // 重放/重复帧：幂等接受但不再入重组。
      return true;
    }
    lastInboundFrameSeq = frame.seq;
    if (!isSameBridgeIdentity(options.identity, frame)) {
      return false;
    }
    if (!BASE64_PATTERN.test(frame.dataBase64)) {
      options.onFault("remote.rpcFrame.invalidPayload", frame.messageSeq);
      return false;
    }
    const chunk = new Uint8Array(Buffer.from(frame.dataBase64, "base64"));
    if (chunk.byteLength === 0 || chunk.byteLength > RPC_FRAME_LIMITS.maxPhysicalFrameBytes) {
      options.onFault("remote.rpcFrame.invalidPayload", frame.messageSeq);
      return false;
    }
    let assembly = assemblies.get(frame.messageSeq);
    if (!assembly) {
      assembly = {
        parts: Array.from<Uint8Array | undefined>({ length: frame.fragmentCount }),
        receivedCount: 0,
        fragmentCount: frame.fragmentCount,
        messageBytes: frame.messageBytes,
        checksum: frame.checksum.value,
        startedAt: options.now(),
      };
      assemblies.set(frame.messageSeq, assembly);
    } else if (
      assembly.fragmentCount !== frame.fragmentCount ||
      assembly.messageBytes !== frame.messageBytes ||
      assembly.checksum !== frame.checksum.value
    ) {
      // 同 messageSeq 片元数据冲突：重组上下文不可信，整体作废。
      assemblies.delete(frame.messageSeq);
      options.onFault("remote.rpcFrame.invalidPayload", frame.messageSeq);
      return false;
    }
    if (assembly.parts[frame.fragmentIndex]) {
      return true;
    }
    assembly.parts[frame.fragmentIndex] = chunk;
    assembly.receivedCount += 1;
    if (assembly.receivedCount < assembly.fragmentCount) {
      return true;
    }
    const totalLength = assembly.parts.reduce((sum, part) => sum + (part?.byteLength ?? 0), 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of assembly.parts) {
      if (!part) {
        assemblies.delete(frame.messageSeq);
        options.onFault("remote.rpcFrame.invalidPayload", frame.messageSeq);
        return false;
      }
      merged.set(part, offset);
      offset += part.byteLength;
    }
    deliverAssembly(frame.messageSeq, assembly, merged);
    return true;
  }

  return {
    acceptFrame,
    sweepStale(): void {
      const staleCutoff = options.now() - options.assemblyTimeoutMs;
      for (const [messageSeq, assembly] of Array.from(assemblies)) {
        if (assembly.startedAt < staleCutoff) {
          assemblies.delete(messageSeq);
        }
      }
    },
    reset(): void {
      assemblies.clear();
      lastInboundFrameSeq = 0;
    },
  };
}
