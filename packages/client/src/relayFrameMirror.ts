// 0C-4④：relay 帧编解码纯函数已下沉 shared/web-remote-control/relay-ops.ts
//（与 desktop webRemoteControl 三件共用同一实现，镜像 diff 归零）。本文件保留
// 兼容导出面，消费方（relayAckMirror 等）零改动。
export {
  MAX_FRAGMENT_DATA_BYTES,
  base64ToBytes,
  bytesToBase64,
  crc32Hex,
  createRelayFrameAssembler,
  createRelayReplayBuffer,
  encodeMessageFrames,
  measureFrameBytesDefault,
} from "@zcode/shared/web-remote-control";
export type {
  EncodeMessageResult,
  RelayFrameAssemblerOptions,
} from "@zcode/shared/web-remote-control";
