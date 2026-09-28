import { z } from "zod";
import {
  failureReasonSchema,
  mobileDeviceInfoSchema,
  mobileViewStateSchema,
} from "./app-messages.js";
import { nonEmptyStringSchema } from "./core.js";

// WebRemoteControlStatus：renderer 只读投影（附录A §7 buildRuntimeStatus）。
// 状态机：idle → starting → running(等待手机连接) → connecting(正在连接手机) → active(手机已连接)；
// error/kicked 旁路。唯一写入方是 desktop main 的 WebRemoteControlManager。

export const webRemoteControlStatusSchema = z
  .object({
    status: z.enum(["idle", "starting", "connecting", "running", "active", "error"]),
    sessionId: z.string(),
    windowControlSessionId: z.string(),
    mobileConnected: z.boolean(),
    mobileViewState: mobileViewStateSchema.optional(),
    mobileDeviceInfo: mobileDeviceInfoSchema.optional(),
    qrUrl: z.string(),
    connectUrl: z.string(),
    workspacePath: z.string(),
    workspaceIdentity: z.string().optional(),
    remoteSessionId: z.string().optional(),
    initialTaskId: z.string().optional(),
    error: z.string().optional(),
    failure: z
      .object({ reason: failureReasonSchema, message: z.string() })
      .strict()
      .optional(),
  })
  .strict();
export type WebRemoteControlStatus = z.infer<typeof webRemoteControlStatusSchema>;

export const webRemoteControlStartResultSchema = z
  .object({
    status: z.enum(["active", "running"]),
    sessionId: nonEmptyStringSchema,
    windowControlSessionId: nonEmptyStringSchema,
    qrUrl: z.string(),
    connectUrl: z.string(),
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: z.string().optional(),
    remoteSessionId: z.string().optional(),
    initialTaskId: z.string().optional(),
  })
  .strict();
export type WebRemoteControlStartResult = z.infer<typeof webRemoteControlStartResultSchema>;

/** start/refresh 的上下文（workspaceKey 由 workspaceIdentity?.trim()||workspacePath 派生，不入线）。 */
export const webRemoteControlContextSchema = z
  .object({
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: z.string().optional(),
    remoteSessionId: z.string().optional(),
    initialTaskId: z.string().optional(),
  })
  .strict();
export type WebRemoteControlContext = z.infer<typeof webRemoteControlContextSchema>;

/** 配对 URL 查询参数形态（附录A §1）：…/remote/v4?sid&hash&t&mid&name&app_version */
export const pairingUrlParamsSchema = z
  .object({
    sid: nonEmptyStringSchema,
    hash: nonEmptyStringSchema,
    t: z.number().int().min(0),
    mid: nonEmptyStringSchema,
    name: z.string(),
    app_version: z.string(),
  })
  .strict();
export type PairingUrlParams = z.infer<typeof pairingUrlParamsSchema>;

export function buildPairingUrl(baseUrl: string, params: PairingUrlParams): string {
  const url = new URL(baseUrl);
  url.searchParams.set("sid", params.sid);
  url.searchParams.set("hash", params.hash);
  url.searchParams.set("t", String(params.t));
  url.searchParams.set("mid", params.mid);
  url.searchParams.set("name", params.name);
  url.searchParams.set("app_version", params.app_version);
  return url.toString();
}

/** 手机端失败语义 → 弹窗横幅 i18n key 映射（kicked 分流由 message 含 "kicked" 判定）。 */
export const failureReasonI18nKeys: Readonly<Record<z.infer<typeof failureReasonSchema>, string>> = {
  "session-not-found": "webRemoteControl.failure.sessionNotFound",
  "session-expired": "webRemoteControl.failure.sessionExpired",
  "session-conflict": "webRemoteControl.failure.sessionConflict",
  "workspace-closed": "webRemoteControl.failure.workspaceClosed",
  "desktop-disconnected": "webRemoteControl.failure.desktopDisconnected",
  "invalid-mobile-connection": "webRemoteControl.failure.invalidMobileConnection",
  "desktop-bootstrap-timeout": "webRemoteControl.failure.desktopBootstrapTimeout",
  "connection-recovery-timeout": "webRemoteControl.failure.connectionRecoveryTimeout",
  "relay-unavailable": "webRemoteControl.failure.relayUnavailable",
  "unsupported-action": "webRemoteControl.failure.unsupportedAction",
  "unexpected-error": "webRemoteControl.failure.unexpectedError",
};
