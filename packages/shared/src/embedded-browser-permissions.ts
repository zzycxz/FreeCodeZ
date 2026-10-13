import { z } from "zod";

// ============================================================
// U2-4（移植自 ZCode 3.15.1 站点权限体系，上游 main@≈527158/742108 + renderer
// 询问卡/管理页 + preload 六通道；本模块=类型与决策常量的 shared 单点）
// ============================================================

/** 自动放行集：低风险、无隐私面（上游 allowlist 同集；U1-4 止血已按此拒绝其余）。 */
export const EMBEDDED_BROWSER_AUTO_ALLOWED_PERMISSIONS = [
  "clipboard-sanitized-write",
  "fullscreen",
  "pointerLock",
  "mediaKeySystem",
] as const;

/** 可询问权限（上游 13 项）：管理页逐项三态；询问卡按类聚合展示。 */
export const EMBEDDED_BROWSER_ASKABLE_PERMISSIONS = [
  "media",
  "clipboard-read",
  "geolocation",
  "notifications",
  "midi",
  "midiSysex",
  "idle-detection",
  "speaker-selection",
  "window-management",
  "storage-access",
  "top-level-storage-access",
  "keyboardLock",
  "fileSystem",
] as const;

export type EmbeddedBrowserAskablePermission = (typeof EMBEDDED_BROWSER_ASKABLE_PERMISSIONS)[number];

/** 设备权限（上游走设备选择器）。 */
export const EMBEDDED_BROWSER_DEVICE_PERMISSIONS = ["usb", "hid", "serial"] as const;
export type EmbeddedBrowserDevicePermission = (typeof EMBEDDED_BROWSER_DEVICE_PERMISSIONS)[number];

export const isEmbeddedBrowserAskablePermission = (
  permission: string,
): permission is EmbeddedBrowserAskablePermission =>
  (EMBEDDED_BROWSER_ASKABLE_PERMISSIONS as readonly string[]).includes(permission);

export const isEmbeddedBrowserDevicePermission = (
  permission: string,
): permission is EmbeddedBrowserDevicePermission =>
  (EMBEDDED_BROWSER_DEVICE_PERMISSIONS as readonly string[]).includes(permission);

/** 站点持久设置值（origin×permission → allow|deny；「询问」=删条目回落默认链）。 */
export const embeddedBrowserSitePermissionValueSchema = z.enum(["allow", "deny"]);
export type EmbeddedBrowserSitePermissionValue = z.infer<
  typeof embeddedBrowserSitePermissionValueSchema
>;

/** 持久存储形状：<userData>/embedded-browser-site-permissions.json。 */
export const embeddedBrowserSitePermissionsFileSchema = z
  .object({
    version: z.literal(1),
    entries: z.record(z.string(), z.record(z.string(), embeddedBrowserSitePermissionValueSchema)),
  })
  .strict();
export type EmbeddedBrowserSitePermissionsFile = z.infer<
  typeof embeddedBrowserSitePermissionsFileSchema
>;

/** 询问动作（上游四态卡）。 */
export const embeddedBrowserPermissionActionSchema = z.enum([
  "allow-always",
  "allow-session",
  "block-always",
  "dismiss",
]);
export type EmbeddedBrowserPermissionAction = z.infer<
  typeof embeddedBrowserPermissionActionSchema
>;

/** 询问类型：permission=能力类；device=usb/hid/serial 选择；screen-share=getDisplayMedia。 */
export const embeddedBrowserPermissionPromptKindSchema = z.enum([
  "permission",
  "device",
  "screen-share",
]);
export type EmbeddedBrowserPermissionPromptKind = z.infer<
  typeof embeddedBrowserPermissionPromptKindSchema
>;

export const embeddedBrowserDeviceOptionSchema = z
  .object({
    deviceId: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();
export type EmbeddedBrowserDeviceOption = z.infer<typeof embeddedBrowserDeviceOptionSchema>;

/** main → renderer 询问载荷。 */
export const embeddedBrowserPermissionPromptSchema = z
  .object({
    requestId: z.string().min(1),
    kind: embeddedBrowserPermissionPromptKindSchema,
    origin: z.string().min(1),
    /** kind=permission 时的能力名；device 时机型名（usb/hid/serial）。 */
    permission: z.string().min(1),
    /** kind=device/screen-share 的可选项（设备列表 / 屏幕源列表）。 */
    options: z.array(embeddedBrowserDeviceOptionSchema).optional(),
    /** 触发询问的 guest webContentsId（renderer 按它把卡片归到具体浏览器 tab）。 */
    guestWebContentsId: z.number().int().nonnegative(),
  })
  .strict();
export type EmbeddedBrowserPermissionPrompt = z.infer<typeof embeddedBrowserPermissionPromptSchema>;

/** renderer → main 应答。device/screen-share 需带选中项。 */
export const embeddedBrowserPermissionResolutionSchema = z
  .object({
    requestId: z.string().min(1),
    action: embeddedBrowserPermissionActionSchema,
    selectedDeviceId: z.string().min(1).optional(),
  })
  .strict();
export type EmbeddedBrowserPermissionResolution = z.infer<
  typeof embeddedBrowserPermissionResolutionSchema
>;

/** 询问 UI 超时（上游同款）：超时=拒绝。 */
export const EMBEDDED_BROWSER_PROMPT_TIMEOUT_MS = 20_000;

/** IPC：写单条站点权限（value=null 等价 reset/删条目=回到询问）。 */
export const embeddedBrowserSetSitePermissionPayloadSchema = z
  .object({
    origin: z.string().min(1),
    permission: z.string().min(1),
    value: embeddedBrowserSitePermissionValueSchema.nullable(),
  })
  .strict();
export type EmbeddedBrowserSetSitePermissionPayload = z.infer<
  typeof embeddedBrowserSetSitePermissionPayloadSchema
>;

/** IPC：重置单条站点权限。 */
export const embeddedBrowserResetSitePermissionPayloadSchema = z
  .object({
    origin: z.string().min(1),
    permission: z.string().min(1),
  })
  .strict();
export type EmbeddedBrowserResetSitePermissionPayload = z.infer<
  typeof embeddedBrowserResetSitePermissionPayloadSchema
>;
