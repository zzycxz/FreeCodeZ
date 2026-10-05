// 0C-4④（升级实施手册）：relay 帧编解码纯函数已下沉 shared/web-remote-control/relay-ops.ts
//（与 client/relayFrameMirror.ts 镜像同语义归零）。本文件保留导出面与命名别名，消费方零改动。
export {
  crc32Hex,
  MAX_FRAGMENT_DATA_BYTES,
  measureFrameBytesDefault,
  encodeMessageFrames,
  type EncodeMessageResult,
} from "@zcode/shared/web-remote-control";
export const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;
