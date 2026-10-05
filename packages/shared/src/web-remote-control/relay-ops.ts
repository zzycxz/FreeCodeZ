// 0C-4④（升级实施手册）：从 client/relayFrameMirror.ts 下沉（浏览器+Node 双环境纯函数）。
// desktop webRemoteControl 三件与 client 镜像同语义（291 行镜像归零）。
import {
  RPC_FRAME_LIMITS,
  isSameBridgeIdentity,
  type BridgeSessionIdentity,
  type OutboundBatch,
  type RelayFaultReason,
  type RpcFrame,
  type RpcFrameAck,
} from "@zcode/shared/web-remote-control";

// rpc-frame 编解码/重组/重放缓冲的手机侧镜像（附录A §3.1/§3.2，与 desktop/relayFrameCodec.ts、
// rpcFrameAssembler.ts、replayBuffer.ts 同语义）：crc32（8 位小写 hex）、规范 base64、
// 逻辑消息 ≤16MB 切 ≤64 片（片数据 ≤512KB，物理帧硬限 1MB）、帧 seq 去重单调、身份三元组全等、
// 累计释放 + 前缀压缩。浏览器无 Buffer，base64/crc32 自实现，Node(tsx) 与浏览器共同加载，纯函数可单测。

// ---------- crc32 / base64 ----------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32Hex(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    const tableValue = CRC32_TABLE[(crc ^ bytes[index]!) & 0xff]!;
    crc = tableValue ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index]!;
    const b1 = index + 1 < bytes.length ? bytes[index + 1]! : undefined;
    const b2 = index + 2 < bytes.length ? bytes[index + 2]! : undefined;
    out += BASE64_ALPHABET[b0 >> 2]!;
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    out += b1 === undefined ? "=" : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    out += b2 === undefined ? "=" : BASE64_ALPHABET[b2 & 0x3f]!;
  }
  return out;
}

/** 规范 base64 解码；非法输入返回 null（调用方按 invalidPayload 降级）。 */
export function base64ToBytes(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !BASE64_PATTERN.test(text)) return null;
  if (text.length === 0) return new Uint8Array(0);
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let outIndex = 0;
  for (let index = 0; index < text.length; index += 4) {
    const c0 = BASE64_ALPHABET.indexOf(text[index]!);
    const c1 = BASE64_ALPHABET.indexOf(text[index + 1]!);
    const c2 = text[index + 2] === "=" ? 0 : BASE64_ALPHABET.indexOf(text[index + 2]!);
    const c3 = text[index + 3] === "=" ? 0 : BASE64_ALPHABET.indexOf(text[index + 3]!);
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) return null;
    out[outIndex++] = (c0 << 2) | (c1 >> 4);
    if (outIndex < out.length) out[outIndex++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (outIndex < out.length) out[outIndex++] = ((c2 & 0x03) << 6) | c3;
  }
  return out;
}

/** 片段数据 ≤512KB：base64 展开约 699KB，加信封后仍低于物理帧 1MB 硬限。 */
export const MAX_FRAGMENT_DATA_BYTES = RPC_FRAME_LIMITS.maxPhysicalFrameBytes >> 1;

export function measureFrameBytesDefault(frame: RpcFrame | RpcFrameAck): number {
  return new TextEncoder().encode(JSON.stringify(frame)).byteLength;
}

// ---------- 逻辑消息 → rpc-frame 分片 ----------

export type EncodeMessageResult =
  | { ok: true; frames: RpcFrame[]; outerBytes: number }
  | { ok: false; reason: RelayFaultReason };

export function encodeMessageFrames(params: {
  identity: BridgeSessionIdentity;
  bytes: Uint8Array;
  messageSeq: number;
  /** 本消息首帧的 seq-1；调用方持有全局 seq 计数器。 */
  startFrameSeq: number;
  measureFrameBytes?: (frame: RpcFrame | RpcFrameAck) => number;
}): EncodeMessageResult {
  const measure = params.measureFrameBytes ?? measureFrameBytesDefault;
  const { identity, bytes } = params;
  if (bytes.byteLength === 0 || bytes.byteLength > RPC_FRAME_LIMITS.maxMessageBytes) {
    return { ok: false, reason: "remote.rpcFrame.encodingFailed" };
  }
  const fragmentCount = Math.min(
    RPC_FRAME_LIMITS.maxFragments,
    Math.max(1, Math.ceil(bytes.byteLength / MAX_FRAGMENT_DATA_BYTES)),
  );
  const chunkSize = Math.ceil(bytes.byteLength / fragmentCount);
  const checksumValue = crc32Hex(bytes);
  const frames: RpcFrame[] = [];
  let outerBytes = 0;
  for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
    const start = fragmentIndex * chunkSize;
    const chunk = bytes.subarray(start, Math.min(start + chunkSize, bytes.byteLength));
    const frame: RpcFrame = {
      zcode_type: "rpc-frame",
      bridgeSessionId: identity.bridgeSessionId,
      ...(identity.bridgeGeneration == null ? {} : { bridgeGeneration: identity.bridgeGeneration }),
      ...(identity.recoveryId == null ? {} : { recoveryId: identity.recoveryId }),
      seq: params.startFrameSeq + 1 + fragmentIndex,
      messageSeq: params.messageSeq,
      fragmentIndex,
      fragmentCount,
      messageBytes: bytes.byteLength,
      checksum: { algorithm: "crc32", value: checksumValue },
      dataBase64: bytesToBase64(chunk),
    };
    const frameBytes = measure(frame);
    if (frameBytes > RPC_FRAME_LIMITS.maxPhysicalFrameBytes) {
      return { ok: false, reason: "remote.rpcFrame.outerMeterFailed" };
    }
    outerBytes += frameBytes;
    frames.push(frame);
  }
  return { ok: true, frames, outerBytes };
}

// ---------- 入站重组（seq 去重单调、身份三元组全等、base64/crc32/长度全等校验） ----------

export interface RelayFrameAssemblerOptions {
  identity: BridgeSessionIdentity;
  assemblyTimeoutMs: number;
  now(): number;
  onDeliver(bytes: Uint8Array, messageSeq: number): void;
  onFault(reason: RelayFaultReason, messageSeq: number): void;
}

interface InboundAssembly {
  parts: Array<Uint8Array | undefined>;
  receivedCount: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: string;
  startedAt: number;
}

export function createRelayFrameAssembler(options: RelayFrameAssemblerOptions) {
  const assemblies = new Map<number, InboundAssembly>();
  let lastInboundFrameSeq = 0;

  function deliverAssembly(messageSeq: number, assembly: InboundAssembly, bytes: Uint8Array): void {
    assemblies.delete(messageSeq);
    if (bytes.byteLength !== assembly.messageBytes || crc32Hex(bytes) !== assembly.checksum) {
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
    if (!isSameBridgeIdentity(options.identity, frame)) return false;
    const chunk = base64ToBytes(frame.dataBase64);
    if (!chunk || chunk.byteLength === 0 || chunk.byteLength > RPC_FRAME_LIMITS.maxPhysicalFrameBytes) {
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
    if (assembly.parts[frame.fragmentIndex]) return true;
    assembly.parts[frame.fragmentIndex] = chunk;
    assembly.receivedCount += 1;
    if (assembly.receivedCount < assembly.fragmentCount) return true;
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
        if (assembly.startedAt < staleCutoff) assemblies.delete(messageSeq);
      }
    },
    reset(): void {
      assemblies.clear();
      lastInboundFrameSeq = 0;
    },
  };
}

// ---------- 重放缓冲（batches[i] 对应 messageSeq = i + 1，累计释放 + 前缀压缩） ----------

export function createRelayReplayBuffer(options: { maxBytes: number; now(): number }) {
  let batches: Array<OutboundBatch | undefined> = [];
  let headIndex = 0;
  let unackedBytes = 0;

  function compactReleasedPrefix(): void {
    if (headIndex >= 1024 && headIndex * 2 >= batches.length) {
      batches = batches.slice(headIndex);
      headIndex = 0;
    }
  }

  return {
    enqueue(batch: OutboundBatch): { ok: true } | { ok: false; reason: RelayFaultReason } {
      if (unackedBytes + batch.outerBytes > options.maxBytes) {
        return { ok: false, reason: "remote.rpcFrame.replayBufferExceeded" };
      }
      batches.push(batch);
      unackedBytes += batch.outerBytes;
      return { ok: true };
    },
    releaseThrough(messageSeq: number): void {
      while (headIndex < batches.length) {
        const batch = batches[headIndex];
        if (!batch || batch.messageSeq > messageSeq) break;
        batches[headIndex] = undefined;
        unackedBytes = Math.max(0, unackedBytes - batch.outerBytes);
        headIndex += 1;
      }
      compactReleasedPrefix();
    },
    unacknowledgedBytes: () => unackedBytes,
    forEachUnacked(visit: (batch: OutboundBatch) => boolean | void): void {
      for (let index = headIndex; index < batches.length; index += 1) {
        const batch = batches[index];
        if (!batch) continue;
        if (visit(batch) === false) return;
      }
    },
    findOverdueBatch(now: number, graceMs: number): OutboundBatch | null {
      for (let index = headIndex; index < batches.length; index += 1) {
        const batch = batches[index];
        if (!batch) continue;
        if (now - batch.queuedAt > graceMs) return batch;
      }
      return null;
    },
    clear(): void {
      batches = [];
      headIndex = 0;
      unackedBytes = 0;
    },
  };
}
