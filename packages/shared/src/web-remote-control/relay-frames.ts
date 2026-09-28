import { z } from "zod";
import { nonEmptyStringSchema } from "./core.js";

// Relay 传输层握手帧（附录A §1，WSS JSON 文本帧）。
// relay 职责仅：设备注册、challenge-response 鉴权、单终端配对、心跳应答、data 转发、KICKED。
// 所有业务状态在桌面（WebRemoteControlManager），relay 不落任何业务数据。

export const relayDeviceMetaSchema = z
  .object({
    platform: nonEmptyStringSchema,
    version: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
  })
  .strict();
export type RelayDeviceMeta = z.infer<typeof relayDeviceMetaSchema>;

export const relayPairStatusSchema = z.enum(["waiting", "matched"]);
export type RelayPairStatus = z.infer<typeof relayPairStatusSchema>;

export const deviceRegisterInitSchema = z
  .object({
    type: z.literal("device_register_init"),
    device_mid: nonEmptyStringSchema,
    pass_hash: nonEmptyStringSchema,
    meta: relayDeviceMetaSchema,
    client_ts: z.number().int().min(0),
  })
  .strict();
export type DeviceRegisterInit = z.infer<typeof deviceRegisterInitSchema>;

export const deviceRegisterAckSchema = z
  .object({
    type: z.literal("device_register_ack"),
    device_sid: nonEmptyStringSchema,
  })
  .strict();
export type DeviceRegisterAck = z.infer<typeof deviceRegisterAckSchema>;

export const authInitSchema = z
  .object({
    type: z.literal("auth_init"),
    role: z.literal("device"),
    device_sid: nonEmptyStringSchema,
    meta: relayDeviceMetaSchema,
    client_ts: z.number().int().min(0),
  })
  .strict();
export type AuthInit = z.infer<typeof authInitSchema>;

export const authChallengeSchema = z
  .object({
    type: z.literal("auth_challenge"),
    nonce: nonEmptyStringSchema,
  })
  .strict();
export type AuthChallenge = z.infer<typeof authChallengeSchema>;

export const authResponseSchema = z
  .object({
    type: z.literal("auth_response"),
    device_sid: nonEmptyStringSchema,
    // proof = base64url(HMAC-SHA256(passHash, `${nonce}|device|${deviceSid}`))
    proof: nonEmptyStringSchema,
    client_ts: z.number().int().min(0),
  })
  .strict();
export type AuthResponse = z.infer<typeof authResponseSchema>;

export const authAckSchema = z
  .object({
    type: z.literal("auth_ack"),
    pair_status: relayPairStatusSchema,
  })
  .strict();
export type AuthAck = z.infer<typeof authAckSchema>;

export const pairStatusQuerySchema = z
  .object({
    type: z.literal("pair_status_query"),
    device_sid: nonEmptyStringSchema,
    client_ts: z.number().int().min(0),
  })
  .strict();
export type PairStatusQuery = z.infer<typeof pairStatusQuerySchema>;

export const pairStatusAckSchema = z
  .object({
    type: z.literal("pair_status_ack"),
    pair_status: relayPairStatusSchema,
  })
  .strict();
export type PairStatusAck = z.infer<typeof pairStatusAckSchema>;

export const relayErrorCodeSchema = z.enum(["KICKED", "AUTH_FAILED", "INTERNAL", "WRONG_PARAM"]);
export type RelayErrorCode = z.infer<typeof relayErrorCodeSchema>;

export const relayErrorSchema = z
  .object({
    type: z.literal("error"),
    code: relayErrorCodeSchema,
    message: z.string().optional(),
  })
  .strict();
export type RelayError = z.infer<typeof relayErrorSchema>;

/** data 信封的 payload 由 rpc-frames / app-messages 的联合描述（此处避免循环依赖用 unknown）。 */
export const relayDataEnvelopeSchema = z
  .object({
    type: z.literal("data"),
    payload: z.unknown(),
    client_ts: z.number().int().min(0).optional(),
    server_ts: z.number().int().min(0).optional(),
  })
  .strict();
export type RelayDataEnvelope = z.infer<typeof relayDataEnvelopeSchema>;

/** 设备侧接收的 relay 帧全集。 */
export const relayInboundFrameSchema = z.discriminatedUnion("type", [
  deviceRegisterAckSchema,
  authChallengeSchema,
  authAckSchema,
  pairStatusAckSchema,
  relayDataEnvelopeSchema,
  relayErrorSchema,
]);
export type RelayInboundFrame = z.infer<typeof relayInboundFrameSchema>;

/** 设备侧发出的 relay 帧全集。 */
export const relayOutboundFrameSchema = z.discriminatedUnion("type", [
  deviceRegisterInitSchema,
  authInitSchema,
  authResponseSchema,
  pairStatusQuerySchema,
  relayDataEnvelopeSchema,
]);
export type RelayOutboundFrame = z.infer<typeof relayOutboundFrameSchema>;

export const relayTransportStateSchema = z.enum([
  "idle",
  "connecting",
  "registering",
  "authenticating",
  "waiting_terminal",
  "paired",
  "kicked",
  "error",
]);
export type RelayTransportState = z.infer<typeof relayTransportStateSchema>;
