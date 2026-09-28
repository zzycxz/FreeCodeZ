import { z } from "zod";

// Bot 持久化 schema（附录B §5.4，bot-config.v3.json / bot-state.v3.json）+ 校验与规范化（§5.1/§5.2）。
// 写文件统一 JSON.stringify(x,null,2)+"\n" + 原子写 + 文件锁（services 侧执行）。

export const botProviderSchema = z.enum([
  "telegram",
  "webhook",
  "feishu",
  "lark",
  "weixin",
  "discord",
  "wecom",
]);
export type BotProvider = z.infer<typeof botProviderSchema>;

export const replyModeSchema = z.enum([
  "assistant_changes",
  "assistant_toolcalls_changes",
  "summary_changes",
  "streaming_card",
]);
export type ReplyMode = z.infer<typeof replyModeSchema>;

/** 轮询型渠道（不允许共享 credentialRef）。 */
export const POLLING_BOT_PROVIDERS: ReadonlySet<BotProvider> = new Set([
  "telegram",
  "feishu",
  "lark",
]);

export const feishuAppIdSchema = z.string().regex(/^cli_[0-9a-fA-F]{16}$/u);

export const modelSelectionSchema = z
  .object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    options: z.object({ reasoningLevel: z.string().optional() }).strict().optional(),
  })
  .strict();
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

export const botCommandPolicySchema = z
  .object({
    status: z.boolean(),
    workspace: z.boolean(),
    new: z.boolean(),
    model: z.boolean(),
    thoughtLevel: z.boolean(),
    reply: z.boolean(),
    mode: z.boolean().optional(),
    sandboxMode: z.boolean().optional(),
    approvalPolicy: z.boolean().optional(),
    cli: z.boolean().optional(),
  })
  .strict();
export type BotCommandPolicy = z.infer<typeof botCommandPolicySchema>;

export const botCurrentOptionsSchema = z
  .object({
    modelSelection: modelSelectionSchema.optional(),
    mode: z.string().optional(),
    sandboxMode: z.string().optional(),
    approvalPolicy: z.string().optional(),
    cli: z.enum(["codex", "claude", "opencode", "gemini", "glm"]).optional(),
  })
  .strict();
export type BotCurrentOptions = z.infer<typeof botCurrentOptionsSchema>;

export const botConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    provider: botProviderSchema,
    enabled: z.boolean(),
    credentialRef: z.string().optional(),
    webhookSecretRef: z.string().optional(),
    webhookUrl: z.url().optional(),
    webhookAuthHeaderName: z.string().optional(),
    feishuAppId: z.string().optional(),
    providerUserId: z.string().optional(),
    displayName: z.string().optional(),
    allowedWorkspaces: z.array(z.string()),
    allowedCommands: botCommandPolicySchema,
    currentOptions: botCurrentOptionsSchema,
    replyMode: replyModeSchema,
  })
  .strict();
export type BotConfig = z.infer<typeof botConfigSchema>;

export const botsConfigV3Schema = z
  .object({ version: z.literal(3), bots: z.array(botConfigSchema) })
  .strict();
export type BotsConfigV3 = z.infer<typeof botsConfigV3Schema>;

export const pendingElicitationSchema = z
  .object({
    taskId: z.string(),
    requestId: z.string(),
    runId: z.string(),
    origin: z.string().optional(),
    actorKey: z.string().optional(),
    currentQuestionIndex: z.number().int().min(0),
    questions: z.array(
      z
        .object({
          question: z.string(),
          header: z.string(),
          options: z.array(
            z
              .object({
                value: z.string(),
                label: z.string(),
                description: z.string().optional(),
              })
              .strict(),
          ),
          multiSelect: z.boolean().optional(),
        })
        .strict(),
    ),
    answers: z.record(z.string(), z.array(z.string())),
    renderContext: z
      .object({ kind: z.literal("plan_approval"), plan: z.string() })
      .strict()
      .optional(),
    expandedCustomAnswerQuestionIndexes: z.array(z.number().int().min(0)).optional(),
    handledAt: z.number().int().min(0).optional(),
  })
  .strict();
export type PendingElicitation = z.infer<typeof pendingElicitationSchema>;

export const pendingPermissionOptionSchema = z
  .object({
    requestId: z.string(),
    optionId: z.string(),
    command: z.enum(["approve", "deny"]),
    label: z.string(),
    response: z.unknown(),
    handledAt: z.number().int().min(0).optional(),
  })
  .strict();
export type PendingPermissionOption = z.infer<typeof pendingPermissionOptionSchema>;

export const botContextSchema = z
  .object({
    botId: z.string(),
    workspacePath: z.string(),
    workspaceIdentity: z.string().optional(),
    workspaceId: z.string().optional(),
    mode: z.enum(["draft", "task"]),
    activeTaskId: z.string().nullable(),
    draftOptions: z
      .object({
        provider: z.literal("glm"),
        modelSelection: modelSelectionSchema.optional(),
        mode: z.string().optional(),
      })
      .strict()
      .optional(),
    pendingPermissionOptions: z.array(pendingPermissionOptionSchema).optional(),
    pendingElicitation: pendingElicitationSchema.optional(),
    telegramOffset: z.number().int().min(0).optional(),
    weixinGetUpdatesBuf: z.string().optional(),
    weixinActivatedAt: z.number().int().min(0).optional(),
    updatedAt: z.number().int().min(0),
  })
  .strict();
export type BotContext = z.infer<typeof botContextSchema>;

export const botsStateV3Schema = z
  .object({
    version: z.literal(3),
    bots: z.record(z.string(), botContextSchema),
  })
  .strict();
export type BotsStateV3 = z.infer<typeof botsStateV3Schema>;

// ── 校验（附录B §5.1） ──

export type BotConfigIssue =
  | "bot-id-required"
  | "provider-user-duplicated"
  | "polling-credential-shared";

export interface BotConfigValidation {
  ok: boolean;
  issue?: BotConfigIssue;
  message?: string;
}

export function validateBotConfig(
  candidate: BotConfig,
  existingBots: readonly BotConfig[],
): BotConfigValidation {
  if (!candidate.id.trim()) {
    return { ok: false, issue: "bot-id-required", message: "Bot id is required." };
  }
  if (candidate.enabled && candidate.providerUserId) {
    const duplicated = existingBots.some(
      (bot) =>
        bot.id !== candidate.id &&
        bot.enabled &&
        bot.provider === candidate.provider &&
        bot.providerUserId === candidate.providerUserId,
    );
    if (duplicated) {
      return {
        ok: false,
        issue: "provider-user-duplicated",
        message: "An enabled bot with this provider user already exists.",
      };
    }
  }
  if (candidate.enabled && candidate.credentialRef && POLLING_BOT_PROVIDERS.has(candidate.provider)) {
    const shared = existingBots.some(
      (bot) =>
        bot.id !== candidate.id &&
        bot.enabled &&
        bot.provider === candidate.provider &&
        bot.credentialRef === candidate.credentialRef,
    );
    if (shared) {
      return {
        ok: false,
        issue: "polling-credential-shared",
        message: "Enabled polling bots cannot share the same credential.",
      };
    }
  }
  return { ok: true };
}

// ── 规范化（附录B §5.2） ──

export function normalizeAllowedWorkspaces(list: readonly string[]): string[] {
  const trimmed = list.map((item) => item.trim()).filter((item) => item.length > 0);
  if (trimmed.includes("*")) return ["*"];
  return [...new Set(trimmed)];
}

export function isAllWorkspacesAllowed(list: readonly string[]): boolean {
  return list.length === 0 || list.includes("*");
}

export function normalizeBotCommandPolicy(policy: Partial<BotCommandPolicy>): BotCommandPolicy {
  const flag = (value: boolean | undefined): boolean => value !== false;
  return {
    status: flag(policy.status),
    workspace: flag(policy.workspace),
    new: flag(policy.new),
    model: flag(policy.model),
    thoughtLevel: flag(policy.thoughtLevel),
    reply: flag(policy.reply),
    mode: policy.mode,
    sandboxMode: policy.sandboxMode,
    approvalPolicy: policy.approvalPolicy,
    cli: policy.cli,
  };
}

export function normalizeBotReplyGranularity(
  provider: BotProvider,
  mode?: ReplyMode,
): ReplyMode {
  const supported: readonly ReplyMode[] =
    provider === "feishu" || provider === "lark"
      ? ["streaming_card"]
      : ["assistant_changes", "assistant_toolcalls_changes", "summary_changes"];
  return mode && supported.includes(mode) ? mode : supported[0] ?? "assistant_changes";
}

/** provider 归一化（附录B §5.6 勘误：仅 weixin 删 webhookUrl，其余保留）。 */
export function normalizeBotConfig(bot: BotConfig): BotConfig {
  const normalized: BotConfig = {
    ...bot,
    id: bot.id.trim(),
    name: bot.name.trim(),
    allowedWorkspaces: normalizeAllowedWorkspaces(bot.allowedWorkspaces),
    allowedCommands: normalizeBotCommandPolicy(bot.allowedCommands),
    replyMode: normalizeBotReplyGranularity(bot.provider, bot.replyMode),
  };
  if (bot.provider === "weixin") {
    delete normalized.webhookUrl;
  }
  return normalized;
}
