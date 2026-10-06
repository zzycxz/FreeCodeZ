// 0C-4④（升级实施手册）：relay 帧编解码纯函数已下沉 shared/web-remote-control/relay-ops.ts
//（与 client/relayFrameMirror.ts 镜像同语义归零）。本文件保留导出面与命名别名，消费方零改动。
// 注：parseRelayInbound 是 zod 帧解析（随 relay-frames schema 走，非字节编解码族），
// 3a271d3 下沉时误删未留别名——relayTransport.ts 导入即断主包 esbuild（desktop src/main
// 不在 root typecheck 覆盖内，打包是唯一拦截面）；此处按原实现补回（语义零变化）。
import {
  authAckSchema,
  authChallengeSchema,
  deviceRegisterAckSchema,
  pairStatusAckSchema,
  relayDataEnvelopeSchema,
  relayErrorSchema,
  relayInboundFrameSchema,
  type RelayInboundFrame,
} from "@zcode/shared/web-remote-control";

export {
  crc32Hex,
  MAX_FRAGMENT_DATA_BYTES,
  measureFrameBytesDefault,
  encodeMessageFrames,
  type EncodeMessageResult,
} from "@zcode/shared/web-remote-control";
export const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

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
