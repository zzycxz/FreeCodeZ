import {
  RPC_FRAME_LIMITS,
  authAckSchema,
  authChallengeSchema,
  deviceRegisterAckSchema,
  pairStatusAckSchema,
  relayDataEnvelopeSchema,
  relayErrorSchema,
  relayInboundFrameSchema,
  type BridgeSessionIdentity,
  type RelayFaultReason,
  type RelayInboundFrame,
  type RpcFrame,
  type RpcFrameAck,
} from "@zcode/shared/web-remote-control";

// rpc-frame / relay 帧编解码纯函数层（附录A §3.1）：crc32 校验（8 位小写 hex）、规范 base64 校验、
// 逻辑消息 ≤16MB 切 ≤64 片（片数据 ≤512KB，物理帧硬限 1MB）。
// checksum 语义：crc32(完整逻辑消息字节)，逐帧重复携带，重组后与 messageBytes 一并全等校验。

// IEEE 802.3 crc32（自实现，避免依赖 node:zlib crc32 的版本可用性）。
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

export const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;
/** 片段数据 ≤512KB：base64 展开约 699KB，加信封后仍低于物理帧 1MB 硬限。 */
export const MAX_FRAGMENT_DATA_BYTES = RPC_FRAME_LIMITS.maxPhysicalFrameBytes >> 1;

export function measureFrameBytesDefault(frame: RpcFrame | RpcFrameAck): number {
  return Buffer.byteLength(JSON.stringify(frame), "utf8");
}

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
  if (bytes.byteLength === 0) {
    return { ok: false, reason: "remote.rpcFrame.encodingFailed" };
  }
  if (bytes.byteLength > RPC_FRAME_LIMITS.maxMessageBytes) {
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
      dataBase64: Buffer.from(chunk).toString("base64"),
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

/** relay WSS JSON 文本帧 → 类型化入站帧；解析失败返回 null（调用方按 envelope 级丢弃）。 */
export function parseRelayInbound(raw: Buffer): RelayInboundFrame | null {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  const parsed = relayInboundFrameSchema.safeParse(json);
  if (!parsed.success) return null;
  switch (parsed.data.type) {
    case "data": {
      const envelope = relayDataEnvelopeSchema.safeParse(parsed.data);
      return envelope.success ? envelope.data : null;
    }
    case "error": {
      const errorFrame = relayErrorSchema.safeParse(parsed.data);
      return errorFrame.success ? errorFrame.data : null;
    }
    case "device_register_ack": {
      const ack = deviceRegisterAckSchema.safeParse(parsed.data);
      return ack.success ? ack.data : null;
    }
    case "auth_challenge": {
      const challenge = authChallengeSchema.safeParse(parsed.data);
      return challenge.success ? challenge.data : null;
    }
    case "auth_ack": {
      const ack = authAckSchema.safeParse(parsed.data);
      return ack.success ? ack.data : null;
    }
    case "pair_status_ack": {
      const ack = pairStatusAckSchema.safeParse(parsed.data);
      return ack.success ? ack.data : null;
    }
    default:
      return null;
  }
}
