// FreeCodeZ fork(电脑控制能力补位 B2):request_access 状态 schema 校验(轻量手写,
// 不引 zod;形状与 .d.ts 的 CuaRequestAccessStatus 逐字段一致)。

export const CUA_REQUEST_ACCESS_STATUS_META_KEY = "zcode.cua/request-access-status-v1";

const ACCESSIBILITY_STATES = new Set(["granted", "stale", "denied"]);
const SCREEN_RECORDING_STATES = new Set(["unknown", "granted", "denied"]);

export const cuaRequestAccessStatusSchema = {
  safeParse(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { success: false, error: new Error("request-access status must be an object") };
    }
    const { schemaVersion, platform, grantOwner, accessibility, screenRecording } = input;
    if (schemaVersion !== 1) {
      return { success: false, error: new Error("request-access status schemaVersion must be 1") };
    }
    if (platform !== "darwin") {
      return {
        success: false,
        error: new Error("request-access status meta is only produced on darwin"),
      };
    }
    if (typeof grantOwner !== "string" || !grantOwner) {
      return { success: false, error: new Error("request-access status grantOwner must be a string") };
    }
    if (!ACCESSIBILITY_STATES.has(accessibility)) {
      return {
        success: false,
        error: new Error("request-access status accessibility must be granted|stale|denied"),
      };
    }
    if (!SCREEN_RECORDING_STATES.has(screenRecording)) {
      return {
        success: false,
        error: new Error("request-access status screenRecording must be unknown|granted|denied"),
      };
    }
    return {
      success: true,
      data: { schemaVersion: 1, platform: "darwin", grantOwner, accessibility, screenRecording },
    };
  },
};
