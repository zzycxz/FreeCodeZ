// 入站管道（附录B §1.3/§1.5/§2.7/§6）：parseBotCommand → 待选拦截 → withAuthorizedContext
// 授权链（botDisabled→privateChatOnly→userNotBound→commandNotAllowed→noWorkspaceAllowed→
// workspaceOutOfScope→远端未连接）→ 命令分派 / prepareBotMessageContent 建任务（强制 yolo）。
// 2min 去重 key=`botId::provider::chat??user::providerMessageId`；actor 串行队列 Promise 链互斥；
// /reconnect 独立 2min 去重 + 3s 冷却；unknown 命令补门禁（R12）：群聊不回话。
/* eslint-disable max-lines -- 去重/队列/门禁/reconnect/微信激活共享同一 actorKey 与 pendingSelections 生命周期，集中维护幂等边界。 */
import {
  parseBotCommand,
  type BotActor,
  type BotConfig,
  type BotContext,
  type BotSelection,
  type InboundMessage,
  type OutboundMessage,
  type ParsedBotCommand,
} from "@zcode/shared/bots";
import { formatBotMessage, type BotHostLocale } from "./hostMessages.js";
import {
  buildHelpText,
  buildStatusText,
  clearPendingSelection,
  createOutbound,
  handleSelectionCancel,
  isUserCommandAllowed,
  type BotCommandDeps,
} from "./commandHandlers.js";
import { handleParsedCommand, resolveCommandFamily } from "./commandDispatch.js";
import { handleBindCommand } from "./bindHandler.js";
import { handleMessageTaskFlow, type BotAttachmentDeps } from "./messageFlow.js";

const INBOUND_DEDUPE_TTL_MS = 2 * 60_000;
const RECONNECT_COOLDOWN_MS = 3_000;

export interface RemoteWorkspaceGate {
  isConnected(params: { workspacePath: string; workspaceIdentity?: string }): Promise<boolean>;
  reconnect(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ ok: boolean; message?: string }>;
}

export interface BotInboundPipelineDeps extends BotCommandDeps {
  findAuthorizedBot: (actor: BotActor) => Promise<BotConfig | null>;
  readContext: (actor: BotActor, bot: BotConfig) => Promise<BotContext | null>;
  remoteWorkspaceService?: RemoteWorkspaceGate;
  sendTyping?: (bot: BotConfig, actor: BotActor) => Promise<void>;
  attachments: BotAttachmentDeps;
}

export interface AuthorizedContextResult {
  ok: boolean;
  reply?: OutboundMessage[];
  bot?: BotConfig;
  context?: BotContext;
  locale: BotHostLocale;
}

/** buildInboundDeliveryKey（Lr）。 */
export function buildInboundDeliveryKey(message: InboundMessage): string | null {
  const providerMessageId = message.actor.providerMessageId?.trim();
  return providerMessageId
    ? [
        message.actor.botId,
        message.actor.provider,
        message.actor.chatId ?? message.actor.providerUserId,
        providerMessageId,
      ].join("::")
    : null;
}

export function getActorKey(actor: Pick<BotActor, "botId" | "provider" | "chatId" | "providerUserId">): string {
  return [actor.botId, actor.provider, actor.chatId ?? actor.providerUserId].join("::");
}

/** isSelectionIndexValue（Ale）：正整数序号。 */
export function isSelectionIndexValue(value: string): boolean {
  return /^[1-9]\d*$/u.test(value.trim());
}

export class BotInboundPipeline {
  readonly deps: BotInboundPipelineDeps;
  private readonly dedupe = new Map<string, number>();
  private readonly actorQueues = new Map<string, Promise<unknown>>();
  private readonly recentReconnectDelivery = new Map<string, number>();
  private readonly reconnectInFlight = new Map<string, Promise<OutboundMessage[]>>();
  private readonly reconnectCooldown = new Map<string, number>();

  constructor(deps: BotInboundPipelineDeps) {
    this.deps = deps;
  }

  get pendingSelections(): Map<string, BotSelection> {
    return this.deps.pendingSelections;
  }

  /** 2min 去重 + actor 串行队列 + 处理入口。 */
  async handleInboundMessage(message: InboundMessage): Promise<OutboundMessage[]> {
    return this.enqueueInboundProcessing(message.actor, async () => {
      const deliveryKey = buildInboundDeliveryKey(message);
      const now = this.deps.now();
      if (deliveryKey) {
        for (const [key, at] of this.dedupe) {
          if (now - at >= INBOUND_DEDUPE_TTL_MS) this.dedupe.delete(key);
        }
        if (this.dedupe.has(deliveryKey)) return [];
        this.dedupe.set(deliveryKey, now);
      }
      try {
        return await this.processInbound(message);
      } catch (error) {
        // 异常 releaseInboundDelivery 允许重投
        if (deliveryKey) this.dedupe.delete(deliveryKey);
        throw error;
      }
    });
  }

  private enqueueInboundProcessing(
    actor: BotActor,
    run: () => Promise<OutboundMessage[]>,
  ): Promise<OutboundMessage[]> {
    const key = getActorKey(actor);
    const previous = this.actorQueues.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.actorQueues.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  private async processInbound(message: InboundMessage): Promise<OutboundMessage[]> {
    const { actor } = message;
    let parsed: ParsedBotCommand = parseBotCommand(message.text);

    // 待选拦截（§1.3.1）：数字选项仅微信；非微信数字（或非数字）清 pending 后按原义处理
    if (parsed.type === "message") {
      const resolved = this.resolvePendingSelectionCommand(actor, message.text);
      if (resolved) parsed = resolved;
    }
    // §1.3.2：非微信 "0" 清 pending selection 后改当消息进任务
    if (
      parsed.type === "selection.cancel" &&
      actor.provider !== "weixin" &&
      message.text.trim() === "0"
    ) {
      clearPendingSelection(this.deps, actor);
      parsed = { type: "message", text: "0" };
    }
    if (parsed.type === "selection.cancel") {
      const auth = await this.withAuthorizedContext(message, "message");
      if (!auth.ok) return auth.reply ?? [];
      return handleSelectionCancel({
        deps: this.deps,
        bot: auth.bot!,
        actor,
        context: auth.context!,
        locale: auth.locale,
      });
    }
    if (parsed.type === "bind") {
      return handleBindCommand(this.deps, message, parsed.code);
    }
    if (parsed.type === "reconnect") {
      return this.handleReconnect(message);
    }
    if (parsed.type === "message") {
      const activation = await this.handleWeixinFirstActivation(message);
      if (activation) return activation;
      const auth = await this.withAuthorizedContext(message, "message");
      if (!auth.ok) return auth.reply ?? [];
      return handleMessageTaskFlow(
        {
          deps: this.deps,
          bot: auth.bot!,
          actor,
          context: auth.context!,
          locale: auth.locale,
          authorized: true,
        },
        message,
      );
    }
    // R12：unknown 命令补门禁——群聊不回话；私聊走完整授权链后回 unknownCommand
    if (parsed.type === "unknown" && actor.chatType !== "private") {
      return [];
    }
    const family = resolveCommandFamily(parsed);
    const auth = await this.withAuthorizedContext(
      message,
      parsed.type === "unknown" ? "message" : family,
    );
    if (!auth.ok) return auth.reply ?? [];
    return handleParsedCommand(
      { deps: this.deps, bot: auth.bot!, actor, context: auth.context!, locale: auth.locale },
      parsed,
    );
  }

  /** resolvePendingSelectionCommand（kt）：仅微信数字 → 映射回命令；其余清 pending 返回 null。 */
  resolvePendingSelectionCommand(actor: BotActor, text: string): ParsedBotCommand | null {
    const key = getActorKey(actor);
    const selection = this.deps.pendingSelections.get(key);
    if (!selection) return null;
    if (actor.provider !== "weixin" || !isSelectionIndexValue(text)) {
      clearPendingSelection(this.deps, actor);
      return null;
    }
    const resolved = resolveSelectionOptionId(selection.options, text);
    if (!resolved) {
      clearPendingSelection(this.deps, actor);
      return null;
    }
    clearPendingSelection(this.deps, actor);
    switch (selection.action) {
      case "workspace.set":
        return { type: "workspace.set", value: resolved };
      case "model.provider.set":
        return { type: "model.provider.set", value: resolved };
      case "model.set":
        return { type: "model.set", value: resolved };
      case "mode.set":
        return { type: "mode.set", value: resolved };
      case "thoughtLevel.set":
        return { type: "thoughtLevel.set", value: resolved };
      case "task.set":
        return { type: "task.set", value: resolved };
      case "reply.set":
        return { type: "reply.set", value: resolved };
      case "permission.respond":
        return { type: "permission.respond", value: text };
      case "elicitation.respond":
        return { type: "elicitation.respond", value: resolved };
    }
  }

  /**
   * withAuthorizedContext（Bt）：逐级门禁，所有拒绝逐命令回话到 `chatId ?? providerUserId`。
   * bind 自带私聊门禁不走本链；unknown 命令同样过链（R12 补官方漏防）。
   */
  async withAuthorizedContext(
    message: InboundMessage,
    requestedCommand: string,
  ): Promise<AuthorizedContextResult> {
    const locale = await this.deps.resolveLocale();
    const { actor } = message;
    const bot = await this.deps.findAuthorizedBot(actor);
    if (!bot || bot.id !== actor.botId) {
      return { ok: false, locale, reply: [this.reply(actor, locale, "botDisabled")] };
    }
    if (actor.chatType !== "private") {
      return { ok: false, locale, reply: [this.reply(actor, locale, "privateChatOnly")] };
    }
    // findBoundUser（WZ）：weixin 按 botId 即已绑定（bot_token 即身份）
    const bound = actor.provider === "weixin" || bot.providerUserId === actor.providerUserId;
    if (!bound) {
      return { ok: false, locale, reply: [this.reply(actor, locale, "userNotBound")] };
    }
    if (!isUserCommandAllowed(bot, requestedCommand)) {
      return { ok: false, locale, reply: [this.reply(actor, locale, "commandNotAllowed")] };
    }
    const context = await this.deps.readContext(actor, bot);
    if (!context) {
      return { ok: false, locale, reply: [this.reply(actor, locale, "noWorkspaceAllowed")] };
    }
    if (
      context.workspaceId &&
      bot.allowedWorkspaces.length > 0 &&
      !bot.allowedWorkspaces.includes("*") &&
      !bot.allowedWorkspaces.includes(context.workspaceId) &&
      !bot.allowedWorkspaces.includes(context.workspacePath)
    ) {
      return { ok: false, locale, reply: [this.reply(actor, locale, "workspaceOutOfScope")] };
    }
    // 远端拦截（Dr requiresRemoteWorkspaceRuntime）：help/status/workspace/reconnect/reply 豁免
    const remoteExempt = ["help", "status", "workspace", "reconnect", "reply"].includes(
      requestedCommand,
    );
    if (!remoteExempt && context.workspaceIdentity) {
      const connected = (await this.deps.isRemoteConnected?.(context)) ?? false;
      if (!connected) {
        return {
          ok: false,
          locale,
          reply: [
            createOutbound(
              actor,
              formatBotMessage(locale, "remoteDisconnected", {
                workspacePath: context.workspacePath,
              }),
              undefined,
              { locale },
            ),
          ],
        };
      }
    }
    void this.deps.sendTyping?.(bot, actor).catch(() => undefined);
    return { ok: true, locale, bot, context };
  }

  /** /reconnect（XE/H4）：独立 2min 去重 + 进行中复用 + 3s 冷却。 */
  private async handleReconnect(message: InboundMessage): Promise<OutboundMessage[]> {
    const { actor } = message;
    const locale = await this.deps.resolveLocale();
    const now = this.deps.now();
    const deliveryKey = actor.providerMessageId?.trim()
      ? [actor.botId, actor.provider, actor.chatId ?? actor.providerUserId, "reconnect"].join("::")
      : null;
    if (deliveryKey) {
      for (const [key, at] of this.recentReconnectDelivery) {
        if (now - at >= INBOUND_DEDUPE_TTL_MS) this.recentReconnectDelivery.delete(key);
      }
      if (this.recentReconnectDelivery.has(deliveryKey)) return [];
      this.recentReconnectDelivery.set(deliveryKey, now);
    }
    const auth = await this.withAuthorizedContext(message, "workspace");
    if (!auth.ok) return auth.reply ?? [];
    const context = auth.context!;
    const bot = auth.bot!;
    const statusReply = async (): Promise<OutboundMessage[]> => [
      createOutbound(
        actor,
        await buildStatusText({ deps: this.deps, bot, actor, context, locale }),
        undefined,
        { locale },
      ),
    ];
    if (!context.workspaceIdentity) {
      return [
        createOutbound(actor, formatBotMessage(locale, "remoteReconnectLocal"), undefined, { locale }),
      ];
    }
    if (!this.deps.remoteWorkspaceService) {
      return [
        createOutbound(
          actor,
          formatBotMessage(locale, "remoteReconnectUnavailable", {
            workspacePath: context.workspacePath,
          }),
          undefined,
          { locale },
        ),
      ];
    }
    const cooldownKey = getActorKey(actor);
    const inFlight = this.reconnectInFlight.get(cooldownKey);
    if (inFlight) {
      await inFlight.catch(() => []);
      return [];
    }
    const last = this.reconnectCooldown.get(cooldownKey);
    if (last !== undefined && now - last < RECONNECT_COOLDOWN_MS) return [];
    const connected = await this.deps.remoteWorkspaceService.isConnected({
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
    });
    if (connected) {
      return [
        createOutbound(
          actor,
          formatBotMessage(locale, "remoteReconnectAlreadyConnected", {
            workspacePath: context.workspacePath,
          }),
          undefined,
          { locale },
        ),
      ];
    }
    await this.deps.sendOutbound(
      bot,
      createOutbound(
        actor,
        formatBotMessage(locale, "remoteReconnectStarting", {
          workspacePath: context.workspacePath,
        }),
        undefined,
        { locale },
      ),
    );
    const run = (async (): Promise<OutboundMessage[]> => {
      const result = await this.deps
        .remoteWorkspaceService!.reconnect({
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
        })
        .catch((error: unknown) => ({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }));
      if (!result.ok) {
        return [
          createOutbound(
            actor,
            formatBotMessage(locale, "remoteReconnectFailed", {
              workspacePath: context.workspacePath,
              message: result.message ?? "unknown",
            }),
            undefined,
            { locale },
          ),
        ];
      }
      return statusReply();
    })();
    this.reconnectInFlight.set(cooldownKey, run);
    try {
      const replies = await run;
      this.reconnectCooldown.set(cooldownKey, this.deps.now());
      return replies;
    } finally {
      this.reconnectInFlight.delete(cooldownKey);
    }
  }

  /** 微信首条消息激活（ut）：无任何状态时回 weixinActivatedWelcome + help。 */
  private async handleWeixinFirstActivation(
    message: InboundMessage,
  ): Promise<OutboundMessage[] | null> {
    const { actor } = message;
    if (actor.provider !== "weixin") return null;
    const bot = await this.deps.findAuthorizedBot(actor);
    if (!bot) return null;
    const context = await this.deps.readContext(actor, bot);
    if (!context) return null;
    if (
      context.weixinActivatedAt ||
      context.draftOptions ||
      context.activeTaskId ||
      context.pendingPermissionOptions ||
      context.pendingElicitation
    ) {
      return null;
    }
    const auth = await this.withAuthorizedContext(message, "help");
    if (!auth.ok) return auth.reply ?? [];
    const locale = auth.locale;
    await this.deps.writeContext({ ...auth.context!, weixinActivatedAt: this.deps.now() });
    return [
      createOutbound(
        actor,
        [formatBotMessage(locale, "weixinActivatedWelcome"), buildHelpText(locale, bot)].join("\n\n"),
        undefined,
        { locale },
      ),
    ];
  }

  private reply(
    actor: BotActor,
    locale: BotHostLocale,
    key: Parameters<typeof formatBotMessage>[1],
    params?: Record<string, string | number>,
  ): OutboundMessage {
    return createOutbound(actor, formatBotMessage(locale, key, params), undefined, { locale });
  }
}

/** resolveOptionByValue（ai）的 id 解析（数字序号或 id/label 匹配）。 */
export function resolveSelectionOptionId(
  options: ReadonlyArray<{ id: string; label: string }>,
  value: string,
): string | null {
  const trimmed = value.trim();
  if (/^[1-9]\d*$/u.test(trimmed)) {
    return options[Number.parseInt(trimmed, 10) - 1]?.id ?? null;
  }
  const lowered = trimmed.toLowerCase();
  return (
    options.find(
      (option) => option.id.toLowerCase() === lowered || option.label.toLowerCase() === lowered,
    )?.id ?? null
  );
}
