import { z } from "zod";
import type { ReplyMode } from "./schema.js";

// 出/入站消息形状（附录B §2）+ 回复颗粒度目录（§5.2）+ 权限选项排序（§2.2）。

export const botChatTypeSchema = z.enum(["private", "group"]);

export const botAttachmentSchema = z
  .object({
    kind: z.enum(["image", "audio", "video", "file"]),
    id: z.string().optional(),
    filename: z.string(),
    mimeType: z.string().optional(),
    sizeBytes: z.number().optional(),
    providerFileId: z.string().optional(),
    downloadUrl: z.string().optional(),
    dataBase64: z.string().optional(),
    localPath: z.string().optional(),
  })
  .strict();
export type BotAttachment = z.infer<typeof botAttachmentSchema>;

export const botActorSchema = z
  .object({
    provider: z.enum(["telegram", "webhook", "feishu", "lark", "weixin"]),
    botId: z.string(),
    providerUserId: z.string(),
    displayName: z.string().optional(),
    chatType: botChatTypeSchema,
    chatId: z.string().optional(),
    providerMessageId: z.string().optional(),
    providerContextToken: z.string().optional(),
  })
  .strict();
export type BotActor = z.infer<typeof botActorSchema>;

export const inboundMessageSchema = z
  .object({
    botId: z.string(),
    text: z.string(),
    attachments: z.array(botAttachmentSchema).optional(),
    elicitationResponse: z.unknown().optional(),
    actor: botActorSchema,
  })
  .strict();
export type InboundMessage = z.infer<typeof inboundMessageSchema>;

export const selectionOptionSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
  })
  .strict();
export type SelectionOption = z.infer<typeof selectionOptionSchema>;

export const botSelectionSchema = z
  .object({
    id: z.string(),
    token: z.string().optional(),
    title: z.string(),
    action: z.enum([
      "workspace.set",
      "model.provider.set",
      "model.set",
      "mode.set",
      "thoughtLevel.set",
      "task.set",
      "reply.set",
      "permission.respond",
      "elicitation.respond",
    ]),
    options: z.array(selectionOptionSchema),
    currentId: z.string().optional(),
    showCancel: z.boolean().optional(),
    cancelLabel: z.string().optional(),
  })
  .strict();
export type BotSelection = z.infer<typeof botSelectionSchema>;

export const elicitationViewSchema = z
  .object({
    requestId: z.string(),
    taskId: z.string(),
    runId: z.string(),
    currentQuestionIndex: z.number().int().min(0),
    questions: z.array(
      z
        .object({
          question: z.string(),
          header: z.string(),
          options: z.array(
            z
              .object({ value: z.string(), label: z.string(), description: z.string().optional() })
              .strict(),
          ),
          multiSelect: z.boolean().optional(),
        })
        .strict(),
    ),
    answers: z.record(z.string(), z.array(z.string())),
    status: z.enum(["pending", "completed", "cancelled"]),
    expandedCustomAnswerQuestionIndexes: z.array(z.number().int().min(0)).optional(),
    schema: z
      .object({ interaction: z.literal("plan_approval"), plan: z.string() })
      .strict()
      .optional(),
  })
  .strict();
export type ElicitationView = z.infer<typeof elicitationViewSchema>;

export const outboundMessageSchema = z
  .object({
    botId: z.string(),
    provider: z.enum(["telegram", "webhook", "feishu", "lark", "weixin"]),
    providerUserId: z.string(),
    text: z.string(),
    selection: botSelectionSchema.optional(),
    elicitation: elicitationViewSchema.optional(),
    locale: z.enum(["zh-CN", "en-US"]).optional(),
    providerContextToken: z.string().optional(),
  })
  .strict();
export type OutboundMessage = z.infer<typeof outboundMessageSchema>;

export const botDeliveryTargetSchema = z
  .object({
    provider: z.enum(["feishu", "lark", "weixin"]),
    botId: z.string(),
    providerUserId: z.string(),
    chatType: botChatTypeSchema,
  })
  .strict();
export type BotDeliveryTarget = z.infer<typeof botDeliveryTargetSchema>;

// ── 回复颗粒度目录（附录B §5.2 AH 全集） ──

export interface ReplyModeOption {
  mode: ReplyMode;
  labelZh: string;
  labelEn: string;
  descriptionId: string;
  aliases: readonly string[];
}

export const REPLY_MODE_OPTIONS: readonly ReplyModeOption[] = [
  {
    mode: "assistant_changes",
    labelZh: "标准回复",
    labelEn: "Standard reply",
    descriptionId: "bots.replyGranularity.assistantChanges.description",
    aliases: ["assistant", "normal", "default", "standard", "标准"],
  },
  {
    mode: "assistant_toolcalls_changes",
    labelZh: "完整回复",
    labelEn: "Full reply",
    descriptionId: "bots.replyGranularity.assistantToolcallsChanges.description",
    aliases: ["full", "tool", "toolcalls", "完整"],
  },
  {
    mode: "summary_changes",
    labelZh: "摘要回复",
    labelEn: "Summary reply",
    descriptionId: "bots.replyGranularity.summaryChanges.description",
    aliases: ["summary", "latest", "摘要"],
  },
  {
    mode: "streaming_card",
    labelZh: "流式卡片",
    labelEn: "Streaming card",
    descriptionId: "bots.replyGranularity.streamingCard.description",
    aliases: ["stream", "streaming", "流式"],
  },
];

export function listReplyModeOptions(provider: string): readonly ReplyModeOption[] {
  return provider === "feishu" || provider === "lark"
    ? REPLY_MODE_OPTIONS.filter((option) => option.mode === "streaming_card")
    : REPLY_MODE_OPTIONS.filter((option) => option.mode !== "streaming_card");
}

/** 正整数 → 第 n 项；否则小写匹配 alias/label。 */
export function resolveReplyGranularityByValue(
  provider: string,
  value: string,
): ReplyMode | null {
  const options = listReplyModeOptions(provider);
  const asIndex = Number.parseInt(value, 10);
  if (Number.isInteger(asIndex) && String(asIndex) === value.trim() && asIndex >= 1) {
    return options[asIndex - 1]?.mode ?? null;
  }
  const lowered = value.trim().toLowerCase();
  for (const option of options) {
    if (
      option.aliases.some((alias) => alias.toLowerCase() === lowered) ||
      option.labelZh.toLowerCase() === lowered ||
      option.labelEn.toLowerCase() === lowered ||
      option.mode === lowered
    ) {
      return option.mode;
    }
  }
  return null;
}

// ── 权限选项展示（附录B §2.2） ──

export type BotPermissionOptionKind = "allowOnce" | "allowAlways" | "rejectOnce" | "rejectAlways" | "custom";

const PERSISTENT_MARKERS = ["always", "persistent", "permanent", "remember", "始终", "永久", "记住", "不再询问"];
const ALLOW_MARKERS = ["allow", "approve", "accept", "yes", "允许", "同意", "批准"];
const REJECT_MARKERS = ["deny", "reject", "decline", "no", "拒绝", "不允许", "否"];

export function getBotPermissionOptionDisplayKind(
  optionId: string,
  kind: string,
  name: string,
): BotPermissionOptionKind {
  const haystack = `${optionId} ${kind} ${name}`.toLowerCase();
  const persistent = PERSISTENT_MARKERS.some((marker) => haystack.includes(marker.toLowerCase()));
  if (REJECT_MARKERS.some((marker) => haystack.includes(marker.toLowerCase()))) {
    return persistent ? "rejectAlways" : "rejectOnce";
  }
  if (ALLOW_MARKERS.some((marker) => haystack.includes(marker.toLowerCase()))) {
    return persistent ? "allowAlways" : "allowOnce";
  }
  return "custom";
}

const KIND_ORDER: Record<BotPermissionOptionKind, number> = {
  allowOnce: 0,
  allowAlways: 1,
  rejectOnce: 2,
  rejectAlways: 3,
  custom: 4,
};

export function sortBotPermissionOptions<T extends { optionId: string; kind: string; name: string }>(
  options: readonly T[],
): T[] {
  return [...options].sort(
    (a, b) =>
      KIND_ORDER[getBotPermissionOptionDisplayKind(a.optionId, a.kind, a.name)] -
      KIND_ORDER[getBotPermissionOptionDisplayKind(b.optionId, b.kind, b.name)],
  );
}

export function isRejectPermissionOption(option: {
  optionId: string;
  kind: string;
  name: string;
}): boolean {
  const displayKind = getBotPermissionOptionDisplayKind(option.optionId, option.kind, option.name);
  return displayKind === "rejectOnce" || displayKind === "rejectAlways";
}

export type { ReplyMode };
