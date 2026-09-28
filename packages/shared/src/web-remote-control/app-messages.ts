import { z } from "zod";
import { epochMsSchema, nonEmptyStringSchema, transportIdSchema } from "./core.js";
import { rpcFrameAckSchema, rpcFrameSchema } from "./rpc-frames.js";

// 应用层 zcode_type 消息全集（附录A §2，relay data.payload 内）。
// rpc-frame / rpc-frame-ack 可直通 AcknowledgedRelayProtocol。

export const failureReasonSchema = z.enum([
  "session-not-found",
  "session-expired",
  "session-conflict",
  "workspace-closed",
  "desktop-disconnected",
  "invalid-mobile-connection",
  "desktop-bootstrap-timeout",
  "connection-recovery-timeout",
  "relay-unavailable",
  "unsupported-action",
  "unexpected-error",
]);
export type FailureReason = z.infer<typeof failureReasonSchema>;

export const mobileViewStateSchema = z
  .object({
    activeWorkspaceKey: nonEmptyStringSchema.optional(),
    activeTaskId: nonEmptyStringSchema.optional(),
    updatedAt: epochMsSchema,
  })
  .strict();
export type MobileViewState = z.infer<typeof mobileViewStateSchema>;

export const mobileDeviceInfoSchema = z
  .object({
    platform: nonEmptyStringSchema,
    version: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    userAgent: z.string().optional(),
    language: z.string().optional(),
    languages: z.array(z.string()).optional(),
    browserPlatform: z.string().optional(),
    viewport: z
      .object({ width: z.number(), height: z.number(), devicePixelRatio: z.number() })
      .strict()
      .optional(),
    screen: z.object({ width: z.number(), height: z.number() }).strict().optional(),
    timezone: z.string().optional(),
    online: z.boolean().optional(),
    updatedAt: epochMsSchema,
  })
  .strict();
export type MobileDeviceInfo = z.infer<typeof mobileDeviceInfoSchema>;

export const remoteWorkspaceDescriptorSchema = z
  .object({
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema.optional(),
    remoteSessionId: nonEmptyStringSchema.optional(),
    label: nonEmptyStringSchema,
    workspacePurpose: z.enum(["project", "conversation"]).optional(),
    kind: z.enum(["local", "remote"]),
    connectionState: z.enum(["connected", "disconnected", "reconnecting"]).optional(),
    lastConnectionError: z.string().optional(),
  })
  .strict();
export type RemoteWorkspaceDescriptor = z.infer<typeof remoteWorkspaceDescriptorSchema>;

export const remoteTaskListItemSchema = z
  .object({
    taskId: nonEmptyStringSchema,
    title: z.string(),
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema.optional(),
    remoteSessionId: nonEmptyStringSchema.optional(),
    workspaceLabel: nonEmptyStringSchema,
    workspaceKind: z.enum(["local", "remote"]),
    createdAt: epochMsSchema,
    updatedAt: epochMsSchema,
    provider: z.enum(["claude", "opencode", "gemini", "codex", "glm"]).optional(),
    unreadAt: epochMsSchema.optional(),
    displayStatus: z.enum(["idle", "running", "completed", "error"]).optional(),
    hasBackgroundWork: z.boolean().optional(),
    workflowActivity: z.unknown().optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .strict();
export type RemoteTaskListItem = z.infer<typeof remoteTaskListItemSchema>;

export const bootstrapResultSchema = z
  .object({
    windowControlSessionId: nonEmptyStringSchema,
    desktopAppVersion: nonEmptyStringSchema.optional(),
    workspaces: z.array(remoteWorkspaceDescriptorSchema),
    tasks: z.array(remoteTaskListItemSchema),
    initialViewState: mobileViewStateSchema.optional(),
    mobileViewState: mobileViewStateSchema.optional(),
  })
  .strict();
export type BootstrapResult = z.infer<typeof bootstrapResultSchema>;

export const workspaceListResultSchema = z
  .object({
    workspaces: z.array(remoteWorkspaceDescriptorSchema),
    tasks: z.array(remoteTaskListItemSchema).optional(),
    activeWorkspaceKey: z.string().optional(),
    activeTaskId: z.string().optional(),
  })
  .strict();
export type WorkspaceListResult = z.infer<typeof workspaceListResultSchema>;

export const bridgeSpecSchema = z.discriminatedUnion("kind", [
  z
    .object({
      bridgeSessionId: transportIdSchema,
      bridgeGeneration: z.number().int().min(0).optional(),
      recoveryId: transportIdSchema.optional(),
      kind: z.literal("local"),
      workspaceKey: nonEmptyStringSchema,
      workspacePath: nonEmptyStringSchema,
      initialTaskId: nonEmptyStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      bridgeSessionId: transportIdSchema,
      bridgeGeneration: z.number().int().min(0).optional(),
      recoveryId: transportIdSchema.optional(),
      kind: z.literal("remote"),
      workspaceKey: nonEmptyStringSchema,
      workspacePath: nonEmptyStringSchema,
      workspaceIdentity: nonEmptyStringSchema,
      remoteSessionId: nonEmptyStringSchema,
      initialTaskId: nonEmptyStringSchema.optional(),
    })
    .strict(),
]);
export type BridgeSpec = z.infer<typeof bridgeSpecSchema>;

/** platform-request 白名单（7 个，附录A §2；勘误：无 saveMcpFromUserDirectory）。 */
export const platformMethodSchema = z.enum([
  "isDockerAvailable",
  "listWSLDistros",
  "listDockerContainers",
  "listSSHConfigAliases",
  "loadMcpFromUserDirectory",
  "saveMcpToUserDirectory",
  "migrateLegacyCommonMcp",
]);
export type PlatformMethod = z.infer<typeof platformMethodSchema>;

export const mobileDiagnosticEventSchema = z.enum([
  "state-transition",
  "socket-close",
  "socket-error",
  "recover-start",
  "recover-scheduled",
  "pair-status",
  "failure",
]);
export type MobileDiagnosticEvent = z.infer<typeof mobileDiagnosticEventSchema>;

const requestIdField = { requestId: nonEmptyStringSchema };

export const appMessageSchema = z.discriminatedUnion("zcode_type", [
  z.object({ zcode_type: z.literal("telemetry-report"), event: z.unknown() }).strict(),
  z.object({ zcode_type: z.literal("bootstrap-request"), ...requestIdField }).strict(),
  z
    .object({
      zcode_type: z.literal("bootstrap-response"),
      ...requestIdField,
      success: z.literal(true),
      result: bootstrapResultSchema,
    })
    .strict(),
  z.object({ zcode_type: z.literal("workspace-list-request"), ...requestIdField }).strict(),
  z
    .object({
      zcode_type: z.literal("workspace-list-response"),
      ...requestIdField,
      success: z.literal(true),
      result: workspaceListResultSchema,
    })
    .strict(),
  z
    .object({
      zcode_type: z.literal("workspace-list-updated"),
      result: workspaceListResultSchema,
    })
    .strict(),
  z
    .object({
      zcode_type: z.literal("workspace-bridge-open"),
      ...requestIdField,
      bridgeSessionId: transportIdSchema,
      bridgeGeneration: z.number().int().min(0).optional(),
      recoveryId: transportIdSchema.optional(),
      workspaceKey: nonEmptyStringSchema,
      taskId: nonEmptyStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      zcode_type: z.literal("workspace-bridge-ready"),
      ...requestIdField,
      bridgeSessionId: transportIdSchema,
      bridgeGeneration: z.number().int().min(0).optional(),
      recoveryId: transportIdSchema.optional(),
      bridge: bridgeSpecSchema,
    })
    .strict(),
  z
    .object({
      zcode_type: z.literal("workspace-bridge-error"),
      ...requestIdField,
      bridgeSessionId: transportIdSchema.optional(),
      bridgeGeneration: z.number().int().min(0).optional(),
      recoveryId: transportIdSchema.optional(),
      reason: failureReasonSchema,
      error: z.string(),
    })
    .strict(),
  z
    .object({
      zcode_type: z.literal("workspace-reconnect-request"),
      ...requestIdField,
      workspaceKey: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      zcode_type: z.literal("workspace-reconnect-response"),
      ...requestIdField,
      workspaceKey: nonEmptyStringSchema,
      success: z.boolean(),
      error: z.string().optional(),
    })
    .strict(),
  z
    .object({
      zcode_type: z.literal("mobile-view-state-update"),
      viewState: mobileViewStateSchema,
      deviceInfo: mobileDeviceInfoSchema.optional(),
    })
    .strict(),
  z
    .object({
      zcode_type: z.literal("platform-request"),
      ...requestIdField,
      method: platformMethodSchema,
      args: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      zcode_type: z.literal("platform-response"),
      ...requestIdField,
      method: platformMethodSchema,
      success: z.boolean(),
      result: z.unknown().optional(),
      error: z.string().optional(),
    })
    .strict(),
  rpcFrameSchema,
  rpcFrameAckSchema,
  z
    .object({
      zcode_type: z.literal("bridge-degraded"),
      bridgeSessionId: transportIdSchema,
      bridgeGeneration: z.number().int().min(0).optional(),
      recoveryId: transportIdSchema.optional(),
      reason: z.enum([
        "rpc-transport-fault",
        "rpc-frame-gap",
        "buffer-overflow",
        "buffer-timeout",
      ]),
      seq: z.number().int().min(1).optional(),
      expectedSeq: z.number().int().min(1).optional(),
      droppedCount: z.number().int().min(0).optional(),
    })
    .strict(),
  z
    .object({
      zcode_type: z.literal("app-error"),
      requestId: nonEmptyStringSchema.optional(),
      bridgeSessionId: transportIdSchema.optional(),
      reason: failureReasonSchema,
      error: z.string(),
    })
    .strict(),
  z
    .object({
      zcode_type: z.literal("mobile-diagnostic"),
      event: mobileDiagnosticEventSchema,
      timestamp: epochMsSchema,
      state: z.string().optional(),
      previousState: z.string().optional(),
      pairStatus: z.enum(["waiting", "matched"]).optional(),
      closeCode: z.number().int().optional(),
      closeReason: z.string().optional(),
      wasClean: z.boolean().optional(),
      wasPaired: z.boolean().optional(),
      failureReason: failureReasonSchema.optional(),
      failureMessage: z.string().optional(),
      visibilityState: z.string().optional(),
      online: z.boolean().optional(),
      hiddenDurationMs: z.number().optional(),
    })
    .strict(),
]);
export type AppMessage = z.infer<typeof appMessageSchema>;

/** relay data.payload 判别（rpc-frame 直通可靠层，其余走应用层路由）。 */
export function isRawTransportCandidate(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "zcode_type" in payload &&
    ((payload as { zcode_type?: unknown }).zcode_type === "rpc-frame" ||
      (payload as { zcode_type?: unknown }).zcode_type === "rpc-frame-ack")
  );
}
