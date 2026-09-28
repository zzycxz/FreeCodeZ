// createBotsService（附录B §4.1 createBotsService @817321）：channel "bots" 23 签名 RPC 面装配。
// 状态唯一所有者：bot-config.v3.json / bot-state.v3.json（BotsRepo）、绑定码 Map、入站去重表、
// actor 串行队列、渠道 runtime 生命周期、任务级资源登记表（R13 三路径统一释放）。
/* eslint-disable max-lines -- 23 签名 RPC 面 + 状态装配 + processProviderCallback 流程集中于此，与附录B §4.1 对照维护。 */
import {
  normalizeBotConfig,
  normalizeBotReplyGranularity,
  validateBotConfig,
  type BotActor,
  type BotConfig,
  type BotContext,
  type BotDeliveryTarget,
  type BotProvider,
  type BotsConfigV3,
  type InboundMessage,
  type OutboundMessage,
} from "@zcode/shared/bots";
import { createServiceLogger, type ServiceLogger } from "../logger/serviceLogger.js";
import type { ICredentialService } from "../credential/credential.js";
import type { IBroadcastService } from "../broadcast/broadcast.js";
import { getAppConfigDir } from "../paths.js";
import { BotsRepo } from "./botsRepo.js";
import { BindCodeStore } from "./bindCodes.js";
import { BotResourceRegistry } from "./resourceRegistry.js";
import { BotTaskBridge } from "./taskBridge.js";
import { BotInboundPipeline, type RemoteWorkspaceGate } from "./inboundPipeline.js";
import type {
  BotCallbackResponse,
  BotProviderAdapter,
  BotRuntimeStatusEntry,
  BotTestResult,
  BotTransientCardHandle,
  BotWorkspaceRef,
  CreateBindCodeParams,
  CreateBindCodeResult,
  FeishuRegistrationBegin,
  FeishuRegistrationPoll,
  IBotsService,
  SaveBotParams,
  WatchAutomationRunParams,
  WeixinRegistrationBegin,
  WeixinRegistrationPoll,
} from "./bots.js";
import type { BotAttachmentDeps } from "./attachments.js";
import type { BotModelCatalogProvider, BotModelResolution } from "./commandHandlers.js";
import type { BotTaskServiceLike } from "./taskServiceLike.js";
import type { BotStreamingSender } from "./providers/feishuStreaming.js";
import {
  beginFeishuAccountsRegistration,
  isFeishuSynchronousCardAction,
  pollFeishuAccountsRegistration,
} from "./providers/feishuProvider.js";
import {
  readFeishuVerificationToken,
  verifyWebhookSecret,
} from "./providers/webhookProvider.js";
import {
  beginWeixinQrRegistration,
  pollWeixinQrStatus,
} from "./providers/weixinProvider.js";
import { formatBotMessage, type BotHostLocale } from "./hostMessages.js";
import { createOutbound } from "./commandHandlers.js";

const CREDENTIAL_KEY_PREFIX = "bot:";
const WORKSPACE_REFS_CACHE_MS = 5_000;
/** callback 回执超时（官方 yH=3e3）。 */
const CALLBACK_ACK_TIMEOUT_MS = 3_000;
const RESOLVE_NAME_RETRY_DELAYS: Record<string, readonly number[]> = {
  feishu: [0, 800, 1800],
  lark: [0, 800, 1800],
};
const AUTOMATION_WARN_THROTTLE_MS = 5 * 60_000;

export interface CreateBotsServiceOptions {
  configDir?: string;
  credentialService: ICredentialService;
  taskService: BotTaskServiceLike;
  broadcastService?: Pick<IBroadcastService, "send"> | null;
  settingService?: { get(): Promise<{ locale?: string }> };
  remoteWorkspaceService?: RemoteWorkspaceGate;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: ServiceLogger;
  /** 渠道适配器注入（生产由 node.ts 装配；测试注入 fake）。 */
  adapters?: BotProviderAdapter[];
  listWorkspaceRefs?: () => Promise<BotWorkspaceRef[]>;
  listModelCatalog?: () => Promise<BotModelCatalogProvider[]>;
  resolveModelSelection?: (
    context: BotContext,
    requested?: import("@zcode/shared").ModelSelection,
  ) => Promise<BotModelResolution>;
  createStreamingSender?: (params: {
    bot: BotConfig;
    providerUserId: string;
    locale: BotHostLocale;
  }) => BotStreamingSender | null;
  attachments?: Partial<BotAttachmentDeps>;
  /** 官方 runStartupBackgroundTasks 测试开关；false 不自动拉 runtime。 */
  runStartupBackgroundTasks?: boolean;
  /** 渠道 runtime 工厂（telegram/weixin/feishu 生命周期），由 node.ts 装配。 */
  createRuntimes?: (context: BotRuntimeFactoryContext) => BotRuntimeHandle[];
}

export interface BotRuntimeHandle {
  refresh: () => Promise<void>;
  disposeAll: () => Promise<void>;
}

/** runtime 工厂依赖：入站转发、状态上报、凭据、offset/cursor 落盘。 */
export interface BotRuntimeFactoryContext {
  configDir: string;
  fetchImpl: typeof fetch;
  apiBaseTelegram: string;
  credentialLoader: (key: string) => Promise<string | null>;
  listBots: () => Promise<BotConfig[]>;
  readTelegramOffset: (botId: string) => Promise<number | undefined>;
  writeTelegramOffset: (botId: string, offset: number) => Promise<void>;
  readGetUpdatesBuf: (botId: string) => Promise<string | undefined>;
  writeGetUpdatesBuf: (botId: string, buf: string) => Promise<void>;
  /** 入站投递（官方 Yd 对齐）：payload=渠道原始载荷（TG `{botId,update}`），ack 清键盘靠它取 callback_query。 */
  handleInboundMessage: (message: InboundMessage, payload?: unknown) => Promise<unknown>;
  onStatus: (entry: BotRuntimeStatusEntry) => void;
  logger: ServiceLogger;
  now: () => number;
}

export function createBotsService(options: CreateBotsServiceOptions): IBotsService {
  const configDir = options.configDir ?? getAppConfigDir();
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger ?? createServiceLogger("bots");
  const repo = new BotsRepo({ configDir });
  const bindCodes = new BindCodeStore(now);
  const resourceRegistry = new BotResourceRegistry();
  const pendingSelections = new Map<string, import("@zcode/shared/bots").BotSelection>();
  const runtimeStatus = new Map<string, BotRuntimeStatusEntry>();
  const adapters = new Map<string, BotProviderAdapter>();
  for (const adapter of options.adapters ?? []) adapters.set(adapter.provider, adapter);

  const credentialKey = (botId: string, kind: "credential" | "webhook-secret"): string =>
    `${CREDENTIAL_KEY_PREFIX}${botId}:${kind}`;
  const credentialLoader = async (key: string): Promise<string | null> =>
    options.credentialService.load(key);

  const sendBroadcast = async (message: { channel: string; payload: unknown }): Promise<void> => {
    await options.broadcastService?.send(message);
  };

  const taskBridge = new BotTaskBridge({
    taskService: options.taskService,
    sendBroadcast,
    repo,
    resourceRegistry,
    sendOutbound: (bot, outbound, sendOptions) => sendOutbound(bot, outbound, sendOptions),
    sendTyping: async (bot, actor) => {
      await adapters.get(bot.provider)?.sendTyping?.(bot, actor);
    },
    stopTyping: async (bot, actor) => {
      await adapters.get(bot.provider)?.stopTyping?.(bot, actor);
    },
    finalizeTransientInteractionCard: async ({ bot: _bot, actor, taskId, outbound }) => {
      // 官方 tS：`c.get(J(P))?.taskId===he.taskId` 命中才收口（Mt；卡主体取登记条目 N.bot）
      const entry = transientCards.get(transientCardKey(actor));
      if (!entry || entry.taskId !== taskId) return;
      await finalizeTransientInteractionCard(actor, outbound);
    },
    ...(options.createStreamingSender
      ? { createStreamingSender: options.createStreamingSender }
      : {}),
    logger,
    now,
  });

  // ── 飞书/Lark transient 交互卡（官方 c 表 @754300-757500）：actorKey → {bot, taskId, handle} ──
  const transientCards = new Map<
    string,
    { bot: BotConfig; taskId: string; handle: BotTransientCardHandle; registrationId: number }
  >();

  const transientCardKey = (
    target: Pick<OutboundMessage, "botId" | "provider" | "providerUserId"> | BotActor,
  ): string =>
    [target.botId, target.provider, (target as BotActor).chatId ?? target.providerUserId].join("::");

  const shouldUseTransientInteractionCard = (bot: BotConfig): boolean => {
    const adapter = adapters.get(bot.provider);
    return (
      (bot.provider === "feishu" || bot.provider === "lark") &&
      normalizeBotReplyGranularity(bot.provider, bot.replyMode) === "streaming_card" &&
      !!adapter?.createTransientInteractionCard &&
      !!adapter?.updateTransientInteractionCard
    );
  };

  /**
   * upsertTransientInteractionCard（Kt @754665）：有卡 PATCH 更新，无卡 POST 创建并登记 `{bot, taskId, handle}`。
   * 登记 dispose 仅注销 map 条目——官方 deleteTransientInteractionCard 全构建仅定义、无任何调用点，绝不撤回。
   */
  const upsertTransientInteractionCard = async (
    bot: BotConfig,
    taskId: string,
    outbound: OutboundMessage,
  ): Promise<void> => {
    const adapter = adapters.get(bot.provider);
    if (!adapter?.createTransientInteractionCard || !adapter.updateTransientInteractionCard) return;
    const key = transientCardKey(outbound);
    const existing = transientCards.get(key);
    if (existing) {
      await adapter.updateTransientInteractionCard(existing.bot, existing.handle, outbound);
      return;
    }
    const handle = await adapter.createTransientInteractionCard(bot, outbound);
    if (!handle) return;
    const registrationId = resourceRegistry.registerScoped(bot.id, `transient-card:${key}`, {
      dispose: () => {
        const entry = transientCards.get(key);
        if (!entry || entry.handle !== handle) return;
        transientCards.delete(key);
      },
    });
    transientCards.set(key, { bot, taskId, handle, registrationId });
  };

  /**
   * finalizeTransientInteractionCard（Mt @755240）：收口 = PATCH 终态卡 + 注销登记（finally）。
   * PATCH 载荷 = 收口 outbound 原样进 updateTransientInteractionCard（elicitation→问答/取消卡，其余→文本卡）；
   * 不撤回卡（deleteTransientInteractionCard 无调用点），不另发文本回执。失败仅告警（官方 warn 文案）。
   */
  const finalizeTransientInteractionCard = async (
    target: Pick<OutboundMessage, "botId" | "provider" | "providerUserId"> | BotActor,
    outbound: OutboundMessage,
  ): Promise<boolean> => {
    const key = transientCardKey(target);
    const entry = transientCards.get(key);
    if (!entry) return false;
    const adapter = adapters.get(entry.bot.provider);
    try {
      await adapter?.updateTransientInteractionCard?.(entry.bot, entry.handle, outbound);
    } catch (error) {
      logger.warn(
        undefined,
        `finalize interaction card failed bot=${entry.bot.id} task=${entry.taskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      transientCards.delete(key);
      resourceRegistry.releaseScoped(entry.bot.id, `transient-card:${key}`);
    }
    return true;
  };

  /** en（官方 sendOutbound @754936）：直发，无 transient 路由（任务流内容/错误/直发回执）。 */
  const sendDirect = async (bot: BotConfig, outbound: OutboundMessage): Promise<void> => {
    const adapter = adapters.get(bot.provider);
    if (!adapter) throw new Error(`No bot provider adapter: ${bot.provider}`);
    await adapter.send(bot, outbound);
  };

  /** 任务流交互卡路由（官方 tS 的 `Tt?Kt:en`）：selection/pending elicitation → transient 卡 upsert；其余直发。 */
  const sendOutbound = async (
    bot: BotConfig,
    outbound: OutboundMessage,
    options?: { taskId?: string },
  ): Promise<void> => {
    if (
      shouldUseTransientInteractionCard(bot) &&
      (outbound.selection || outbound.elicitation?.status === "pending")
    ) {
      await upsertTransientInteractionCard(
        bot,
        options?.taskId ?? outbound.elicitation?.taskId ?? "",
        outbound,
      );
      return;
    }
    await sendDirect(bot, outbound);
  };

  /**
   * Yd 发送环（官方 @766050 邻域）：仅入站派生回执按登记卡路由。
   * `We`（登记卡）存在时：selection/pending elicitation → Kt upsert；elicitation 或入站 `/approve|/deny` → Mt 收口；
   * 其余（含无登记卡）→ en 直发。
   */
  const routeCallbackReplies = async (
    bot: BotConfig,
    actor: BotActor,
    inboundText: string,
    outbounds: OutboundMessage[],
  ): Promise<void> => {
    const entry = transientCards.get(transientCardKey(actor));
    for (const outbound of outbounds) {
      try {
        if (entry) {
          if (outbound.selection || outbound.elicitation?.status === "pending") {
            await upsertTransientInteractionCard(bot, entry.taskId, outbound);
            continue;
          }
          if (outbound.elicitation || /^\/(?:approve|deny)(?:\s|$)/u.test(inboundText)) {
            await finalizeTransientInteractionCard(actor, outbound);
            continue;
          }
        }
        await sendDirect(bot, outbound);
      } catch (error) {
        logger.warn(
          undefined,
          `bot outbound delivery failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  const resolveLocale = async (): Promise<BotHostLocale> => {
    const locale = (await options.settingService?.get().catch(() => null))?.locale;
    return locale === "en-US" ? "en-US" : "zh-CN";
  };

  const findBot = async (botId: string): Promise<BotConfig | null> =>
    (await repo.readConfig()).bots.find((bot) => bot.id === botId) ?? null;

  /** findAuthorizedBot（zZ）：weixin 按 botId；其余 enabled+provider+providerUserId。 */
  const findAuthorizedBot = async (actor: BotActor): Promise<BotConfig | null> => {
    const config = await repo.readConfig();
    if (actor.provider === "weixin") {
      return (
        config.bots.find(
          (bot) => bot.enabled && bot.provider === "weixin" && bot.id === actor.botId,
        ) ?? null
      );
    }
    return (
      config.bots.find(
        (bot) =>
          bot.enabled &&
          bot.provider === actor.provider &&
          bot.providerUserId === actor.providerUserId,
      ) ?? null
    );
  };

  let workspaceRefsCache: { at: number; refs: BotWorkspaceRef[] } | null = null;
  const listWorkspaceRefs = async (): Promise<BotWorkspaceRef[]> => {
    if (workspaceRefsCache && now() - workspaceRefsCache.at < WORKSPACE_REFS_CACHE_MS) {
      return workspaceRefsCache.refs;
    }
    const refs = (await options.listWorkspaceRefs?.().catch(() => null)) ?? [];
    workspaceRefsCache = { at: now(), refs };
    return refs;
  };

  const writeContext = async (context: BotContext): Promise<BotContext> => {
    const next: BotContext = { ...context, updatedAt: now() };
    await repo.updateState((state) => ({
      ...state,
      bots: { ...state.bots, [next.botId]: next },
    }));
    return next;
  };

  /**
   * R13 三路径统一释放（deleteBot / 停用 / resetBotState）：
   * 流订阅 + typing interval + transient 卡（dispose → DELETE 撤回）+ pending selection/elicitation。
   */
  const releaseBotLifecycleResources = (botId: string): void => {
    resourceRegistry.releaseBotResources(botId);
    // pending selection 兜底清扫（登记表 dispose 已覆盖，双保险防漏）
    for (const [key] of pendingSelections) {
      if (key.startsWith(`${botId}::`)) pendingSelections.delete(key);
    }
  };

  const writeDraftContext = async (
    context: BotContext,
    draftOptions?: BotContext["draftOptions"],
  ): Promise<BotContext> => {
    releaseBotLifecycleResources(context.botId);
    return writeContext({
      ...context,
      mode: "draft",
      activeTaskId: null,
      draftOptions,
      pendingPermissionOptions: undefined,
      pendingElicitation: undefined,
    });
  };

  const saveBotConfig = async (bot: BotConfig): Promise<BotConfig> => {
    const normalized = normalizeBotConfig(bot);
    await repo.updateConfig((config) => ({
      ...config,
      bots: config.bots.some((item) => item.id === normalized.id)
        ? config.bots.map((item) => (item.id === normalized.id ? normalized : item))
        : [...config.bots, normalized],
    }));
    // R13：停用路径统一释放任务级资源
    if (!normalized.enabled) releaseBotLifecycleResources(normalized.id);
    void scheduleRefresh();
    return normalized;
  };

  /** readContext（Ce）：state 命中则刷新 workspace；否则按允许范围初始化草稿上下文。 */
  const readContext = async (actor: BotActor, bot: BotConfig): Promise<BotContext | null> => {
    const state = await repo.readState();
    const existing = state.bots[bot.id];
    if (existing) return existing;
    const refs = (await listWorkspaceRefs()).filter(
      (ref) =>
        bot.allowedWorkspaces.length === 0 ||
        bot.allowedWorkspaces.includes("*") ||
        bot.allowedWorkspaces.includes(ref.id ?? "") ||
        bot.allowedWorkspaces.includes(ref.workspacePath),
    );
    const ref = refs[0];
    if (!ref) return null;
    void actor;
    return {
      botId: bot.id,
      workspacePath: ref.workspacePath,
      ...(ref.workspaceIdentity ? { workspaceIdentity: ref.workspaceIdentity } : {}),
      ...(ref.id ? { workspaceId: ref.id } : {}),
      mode: "draft",
      activeTaskId: null,
      draftOptions: { provider: "glm" },
      updatedAt: now(),
    };
  };

  const resolveModelSelection: NonNullable<CreateBotsServiceOptions["resolveModelSelection"]> =
    options.resolveModelSelection ??
    (async (_context, requested) => ({
      effectiveSelection: requested ?? null,
      preferredSelection: requested ?? null,
    }));

  const pipeline = new BotInboundPipeline({
    repo,
    bindCodes,
    taskBridge,
    resourceRegistry,
    sendOutbound,
    listWorkspaceRefs,
    listModelCatalog: options.listModelCatalog ?? (async () => []),
    resolveModelSelection,
    pendingSelections,
    now,
    writeDraftContext,
    writeContext,
    saveBotConfig,
    resolveLocale,
    findAuthorizedBot,
    readContext,
    ...(options.remoteWorkspaceService
      ? { remoteWorkspaceService: options.remoteWorkspaceService }
      : {}),
    sendTyping: async (bot, actor) => {
      await adapters.get(bot.provider)?.sendTyping?.(bot, actor);
    },
    attachments: {
      configDir,
      fetchImpl,
      ...(options.attachments?.downloadAttachment
        ? { downloadAttachment: options.attachments.downloadAttachment }
        : {}),
    },
    isRemoteConnected: async (context) => {
      if (!context.workspaceIdentity) return true;
      return (
        (await options.remoteWorkspaceService?.isConnected({
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
        })) ?? false
      );
    },
  });

  const onRuntimeStatus = (entry: BotRuntimeStatusEntry): void => {
    runtimeStatus.set(entry.botId, entry);
  };

  // runtime 生命周期（telegram/weixin/feishu）：createRuntimes 工厂注入，refresh 统一编排
  let runtimeControllers: BotRuntimeHandle[] = [];
  const scheduleRefresh = async (): Promise<void> => {
    for (const controller of runtimeControllers) {
      await controller.refresh().catch((error: unknown) => {
        logger.warn(undefined, `bot runtime refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  };

  const automationWarned = new Map<string, number>();
  const warnAutomationSkip = (provider: string, reason: string): void => {
    const key = `${provider}:${reason}`;
    const last = automationWarned.get(key);
    if (last !== undefined && now() - last < AUTOMATION_WARN_THROTTLE_MS) return;
    automationWarned.set(key, now());
    logger.warn(undefined, `automation Bot delivery skipped provider=${provider} reason=${reason}`);
  };

  /**
   * 官方 Yd 入站鉴权（@762857-763399，逐条）：webhook bot 比对 body `webhookSecret`，
   * 飞书族比对 `payload.token|payload.header.token`；凭据空跳过校验。
   */
  const checkInboundAuth = async (
    config: BotsConfigV3,
    message: InboundMessage,
    payload: unknown,
  ): Promise<boolean> => {
    const messageBot = config.bots.find((candidate) => candidate.id === message.botId);
    if (!messageBot?.webhookSecretRef) return true;
    const expected = await options.credentialService.load(messageBot.webhookSecretRef);
    if (!expected) return true;
    if (messageBot.provider === "webhook") return verifyWebhookSecret(expected, payload).ok;
    if (messageBot.provider === "feishu" || messageBot.provider === "lark") {
      return readFeishuVerificationToken(payload) === expected;
    }
    return true;
  };

  /**
   * Yd ack（@764100 邻域）：处理后、发送环前回执；toast=首条回执文本 ?? "received"。
   * yH=3000ms 超时兜底，失败告警 `provider callback acknowledge failed` 不阻断。
   */
  const acknowledgeInboundCallback = async (
    bot: BotConfig,
    adapter: BotProviderAdapter,
    payload: unknown,
    outbounds: OutboundMessage[],
  ): Promise<void> => {
    const locale = await resolveLocale();
    const text = outbounds[0]?.text ?? formatBotMessage(locale, "received");
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(
            `Bot provider callback acknowledgement timed out after ${CALLBACK_ACK_TIMEOUT_MS}ms.`,
          ),
        ),
      CALLBACK_ACK_TIMEOUT_MS,
    );
    try {
      await Promise.race([
        adapter.acknowledgeCallback?.(bot, payload, text, outbounds[0], controller.signal),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
            once: true,
          });
        }),
      ]);
    } catch (error) {
      logger.warn(
        undefined,
        `provider callback acknowledge failed provider=${bot.provider} bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  };

  /** stopInboundTyping（G @756513）：入站收口取消 typing 指示；任务 typing 挂在同一 providerMessageId 时跳过（留给 K）。 */
  const stopInboundTyping = async (bot: BotConfig, actor: BotActor): Promise<void> => {
    const adapter = adapters.get(bot.provider);
    const target = actor.chatId ?? actor.providerUserId;
    if (!adapter?.stopTyping || !target || !actor.providerMessageId) return;
    if (taskBridge.hasTypingTargetFor(bot.id, actor.providerMessageId)) return;
    await adapter.stopTyping(bot, actor).catch(() => undefined);
  };

  /** processProviderCallback（Yd @762400-766241）：解析→逐条鉴权→去重管道→ack→发送环；失败 callbackFailed；有失败 status 503。 */
  const processProviderCallback = async (
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotCallbackResponse> => {
    const adapter = adapters.get(provider);
    if (!adapter) return { ok: false, replies: [], status: 400 };
    const config = await repo.readConfig();
    const payloadBotId =
      typeof (payload as { botId?: unknown })?.botId === "string"
        ? ((payload as { botId: string }).botId)
        : typeof (payload as { body?: { botId?: unknown } })?.body?.botId === "string"
          ? (payload as { body: { botId: string } }).body.botId
          : "";
    const bot =
      config.bots.find((candidate) => candidate.id === payloadBotId && candidate.provider === provider) ??
      config.bots.find((candidate) => candidate.enabled && candidate.provider === provider) ??
      null;
    const secret = bot?.webhookSecretRef
      ? await options.credentialService.load(bot.webhookSecretRef)
      : null;
    const parsed = await adapter.parseCallback(bot, payload, secret);
    const replies: OutboundMessage[] = [];
    let failed = false;
    for (const message of parsed.messages) {
      // 官方 Yd 逐条鉴权：失配丢弃该条并回 webhookSecretInvalid（只入 replies 不投递渠道；整体 status 200）
      if (!(await checkInboundAuth(config, message, payload))) {
        const locale = await resolveLocale();
        replies.push(
          createOutbound(
            message.actor,
            formatBotMessage(locale, "webhookSecretInvalid"),
            undefined,
            { locale },
          ),
        );
        continue;
      }
      try {
        const outbounds = await pipeline.handleInboundMessage(message);
        replies.push(...outbounds);
        if (bot) {
          // ack 短路（§2.4）：飞书同步卡（card.action.trigger 同步回卡）或已有 transient 卡且
          // 首条回复无 elicitation 时跳过 acknowledgeCallback（视觉收口交给 transient 三段式）
          const syncCardAction =
            (provider === "feishu" || provider === "lark") && isFeishuSynchronousCardAction(payload);
          const skipAck =
            syncCardAction ||
            (transientCards.has(transientCardKey(message.actor)) && !outbounds[0]?.elicitation);
          if (!skipAck) {
            await acknowledgeInboundCallback(bot, adapter, payload, outbounds);
          }
          // 发送环（官方 Yd @766050）：登记卡路由 Kt/Mt，其余 en
          await routeCallbackReplies(bot, message.actor, message.text, outbounds);
          await stopInboundTyping(bot, message.actor);
        }
      } catch (error) {
        failed = true;
        const locale = await resolveLocale();
        const message2 = error instanceof Error ? error.message : String(error);
        const sessionExpired = /\bSession (not found|is not active):/iu.test(message2);
        const actor = message.actor;
        replies.push(
          createOutbound(
            actor,
            sessionExpired
              ? formatBotMessage(locale, "sessionExpiredNewTaskHint")
              : formatBotMessage(locale, "callbackFailed", { message: message2 }),
            undefined,
            { locale },
          ),
        );
      }
    }
    return {
      ok: !failed,
      replies,
      ...(failed ? { status: 503 } : {}),
    };
  };

  const resolveBotCredential = async (bot: BotConfig): Promise<string | null> =>
    bot.credentialRef ? options.credentialService.load(bot.credentialRef) : null;

  const stopRuntimeForBot = async (botId: string): Promise<void> => {
    releaseBotLifecycleResources(botId);
    await scheduleRefresh();
    void botId;
  };

  const service: IBotsService = {    async syncAppRuntimePreferences(): Promise<void> {
      // 官方保留签名：应用 runtime 偏好同步钩子，FreeCodeZ 无对应宿主面
    },
    async getStatus() {
      const config = await repo.readConfig();
      const state = await repo.readState();
      return {
        botsCount: config.bots.length,
        enabledBotsCount: config.bots.filter((bot) => bot.enabled).length,
        contextsCount: Object.keys(state.bots).length,
        botRuntime: [...runtimeStatus.values()],
      };
    },
    async getConfig() {
      return repo.readConfig();
    },
    async listWorkspaceRefs() {
      return listWorkspaceRefs();
    },
    async getUserConfigOptions(): Promise<[]> {
      return [];
    },
    async beginFeishuRegistration(h): Promise<FeishuRegistrationBegin> {
      return beginFeishuAccountsRegistration(fetchImpl, h?.domain ?? "feishu", now);
    },
    async pollFeishuRegistration(h): Promise<FeishuRegistrationPoll> {
      return pollFeishuAccountsRegistration(fetchImpl, h);
    },
    async beginWeixinRegistration(): Promise<WeixinRegistrationBegin> {
      const begin = await beginWeixinQrRegistration(fetchImpl, undefined, now);
      return {
        qrCode: begin.qrCode,
        qrUrl: begin.qrUrl,
        interval: 3,
        expiresAt: begin.expiresAt,
      };
    },
    async pollWeixinRegistration(h): Promise<WeixinRegistrationPoll> {
      return pollWeixinQrStatus(fetchImpl, h.qrcode);
    },
    async saveConfig(h: BotsConfigV3): Promise<BotsConfigV3> {
      const normalized: BotsConfigV3 = {
        ...h,
        bots: h.bots.map((bot) => normalizeBotConfig(bot)),
      };
      for (const bot of normalized.bots) {
        const validation = validateBotConfig(
          bot,
          normalized.bots.filter((item) => item.id !== bot.id),
        );
        if (!validation.ok) throw new Error(validation.message ?? "Invalid bot config.");
      }
      const saved = await repo.updateConfig(() => normalized);
      // R13：批量保存里被停用的 bot 同样走三路径释放
      for (const bot of normalized.bots) {
        if (!bot.enabled) releaseBotLifecycleResources(bot.id);
      }
      void scheduleRefresh();
      return saved;
    },
    async listBots(): Promise<BotConfig[]> {
      return (await repo.readConfig()).bots;
    },
    /** saveBot（§5.3）：归一 → 凭据写入 → resolveName（feishu/lark 重试 [0,800,1800]）→ validate+upsert。 */
    async saveBot(h: SaveBotParams): Promise<BotConfig> {
      const bot = normalizeBotConfig(h.bot);
      if (h.credentialValue !== undefined) {
        await options.credentialService.save(credentialKey(bot.id, "credential"), h.credentialValue);
        bot.credentialRef = credentialKey(bot.id, "credential");
      }
      if (h.webhookSecretValue !== undefined) {
        await options.credentialService.save(
          credentialKey(bot.id, "webhook-secret"),
          h.webhookSecretValue,
        );
        bot.webhookSecretRef = credentialKey(bot.id, "webhook-secret");
      }
      const shouldResolveName = h.credentialValue !== undefined || !bot.name.trim();
      if (shouldResolveName) {
        const adapter = adapters.get(bot.provider);
        const delays = RESOLVE_NAME_RETRY_DELAYS[bot.provider] ?? [0];
        for (const delay of delays) {
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
          const credential = await resolveBotCredential(bot);
          const name = await adapter?.resolveName?.(bot, credential).catch(() => undefined);
          if (name) {
            bot.name = name;
            break;
          }
        }
      }
      const config = await repo.readConfig();
      const validation = validateBotConfig(
        bot,
        config.bots.filter((item) => item.id !== bot.id),
      );
      if (!validation.ok) throw new Error(validation.message ?? "Invalid bot config.");
      const saved = await saveBotConfig(bot);
      // §3.1 setMyCommands 接线：saveBot（启用/凭据变化）同步；停用时 syncCommands(enabled=false) 清命令
      if (saved.provider === "telegram") {
        await adapters.get("telegram")?.syncCommands?.(saved).catch((error: unknown) => {
          logger.warn(
            undefined,
            `sync Telegram commands failed bot=${saved.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      return saved;
    },
    async removeBotSecret(h: { botId: string }): Promise<BotConfig> {
      const bot = await findBot(h.botId);
      if (!bot) throw new Error("bot missing");
      // §3.1：removeBotSecret 清 TG 命令（须在删凭据前，syncCommands 需要 token）
      if (bot.provider === "telegram") {
        await adapters
          .get("telegram")
          ?.syncCommands?.({ ...bot, enabled: false })
          .catch(() => undefined);
      }
      bindCodes.clearBot(h.botId);
      await writeDraftContext({
        botId: h.botId,
        workspacePath: "",
        mode: "draft",
        activeTaskId: null,
        updatedAt: now(),
      }).catch(() => undefined);
      await repo.updateState((state) => {
        const bots = { ...state.bots };
        delete bots[h.botId];
        return { ...state, bots };
      });
      if (bot.credentialRef) await options.credentialService.delete(bot.credentialRef);
      if (bot.webhookSecretRef) await options.credentialService.delete(bot.webhookSecretRef);
      const cleared: BotConfig = {
        ...bot,
        enabled: false,
        credentialRef: undefined,
        webhookSecretRef: undefined,
        ...(bot.provider === "feishu" || bot.provider === "lark" ? { feishuAppId: undefined } : {}),
      };
      await stopRuntimeForBot(h.botId);
      return saveBotConfig(cleared);
    },
    async deleteBot(h: { botId: string }): Promise<void> {
      const bot = await findBot(h.botId);
      if (!bot) return;
      // §3.1：deleteBot 清 TG 命令（须在删凭据前）；R13：三路径统一释放任务级资源
      if (bot.provider === "telegram") {
        await adapters
          .get("telegram")
          ?.syncCommands?.({ ...bot, enabled: false })
          .catch(() => undefined);
      }
      releaseBotLifecycleResources(h.botId);
      bindCodes.clearBot(h.botId);
      await repo.updateConfig((config) => ({
        ...config,
        bots: config.bots.filter((item) => item.id !== h.botId),
      }));
      await repo.updateState((state) => {
        const bots = { ...state.bots };
        delete bots[h.botId];
        return { ...state, bots };
      });
      if (bot.credentialRef) await options.credentialService.delete(bot.credentialRef).catch(() => undefined);
      if (bot.webhookSecretRef) {
        await options.credentialService.delete(bot.webhookSecretRef).catch(() => undefined);
      }
      await stopRuntimeForBot(h.botId);
    },
    async testBot(h: { botId: string }): Promise<BotTestResult> {
      const bot = await findBot(h.botId);
      if (!bot) throw new Error("bot missing");
      const adapter = adapters.get(bot.provider);
      if (!adapter) {
        // 占位渠道（dingding/discord/wecom）：reserved 文案
        return {
          ok: false,
          message: `${bot.provider} is reserved for a future version.`,
          provider: bot.provider,
        };
      }
      return adapter.test(bot, await resolveBotCredential(bot));
    },
    async createBindCode(h: CreateBindCodeParams): Promise<CreateBindCodeResult> {
      const record = bindCodes.create({
        botId: h.botId,
        ...(h.ttlMs !== undefined ? { ttlMs: h.ttlMs } : {}),
        ...(h.allowedWorkspaces ? { allowedWorkspaces: h.allowedWorkspaces } : {}),
      });
      return { code: record.code, expiresAt: record.expiresAt };
    },
    async getBotStates(): Promise<BotContext[]> {
      const state = await repo.readState();
      return Object.values(state.bots);
    },
    async resetBotState(h: { botId: string }): Promise<void> {
      // R13：resetBotState 释放任务级资源（订阅/typing/transient 卡/pending）
      releaseBotLifecycleResources(h.botId);
      await repo.updateState((state) => {
        const bots = { ...state.bots };
        delete bots[h.botId];
        return { ...state, bots };
      });
    },
    async watchAutomationRun(h: WatchAutomationRunParams): Promise<void> {
      const bot = await findBot(h.target.botId);
      if (!bot) {
        warnAutomationSkip(h.target.provider, "bot_missing");
        return;
      }
      if (!bot.enabled) {
        warnAutomationSkip(h.target.provider, "bot_disabled");
        return;
      }
      if (bot.provider !== h.target.provider) {
        warnAutomationSkip(h.target.provider, "provider_mismatch");
        return;
      }
      const actor: BotActor = {
        provider: h.target.provider,
        botId: h.target.botId,
        providerUserId: h.target.providerUserId,
        chatType: h.target.chatType,
      };
      const context: BotContext = {
        botId: bot.id,
        workspacePath: h.workspacePath,
        ...(h.workspaceIdentity ? { workspaceIdentity: h.workspaceIdentity } : {}),
        mode: "task",
        activeTaskId: h.taskId,
        updatedAt: now(),
      };
      // 附录B §9：强制 summary_changes 订阅任务流回发
      taskBridge.watchTaskStream({
        bot,
        actor,
        context,
        locale: await resolveLocale(),
        taskId: h.taskId,
        forceMode: "summary_changes",
      });
    },
    async handleInboundMessage(h: InboundMessage): Promise<OutboundMessage[]> {
      return pipeline.handleInboundMessage(h);
    },
    async handleProviderCallback(provider, payload): Promise<OutboundMessage[]> {
      return (await processProviderCallback(provider, payload)).replies;
    },
    async handleProviderCallbackResponse(provider, payload): Promise<BotCallbackResponse> {
      const result = await processProviderCallback(provider, payload);
      if (provider === "webhook") {
        return { ...result, responseBody: { ok: result.ok, replies: result.replies.length } };
      }
      return result;
    },
    disposeAll(): void {
      void service.disposeAllAndWait();
    },
    async disposeAllAndWait(): Promise<void> {
      resourceRegistry.releaseAll();
      pendingSelections.clear();
      await Promise.allSettled(runtimeControllers.map((controller) => controller.disposeAll()));
    },
  };

  if (options.createRuntimes) {
    runtimeControllers = options.createRuntimes({
      configDir,
      fetchImpl,
      apiBaseTelegram: "https://api.telegram.org",
      credentialLoader,
      listBots: async () => (await repo.readConfig()).bots,
      readTelegramOffset: async (botId) => (await repo.readState()).bots[botId]?.telegramOffset,
      writeTelegramOffset: async (botId, offset) => {
        await repo.updateState((state) => {
          const current = state.bots[botId];
          if (!current) return state;
          return {
            ...state,
            bots: {
              ...state.bots,
              [botId]: { ...current, telegramOffset: offset, updatedAt: now() },
            },
          };
        });
      },
      readGetUpdatesBuf: async (botId) => (await repo.readState()).bots[botId]?.weixinGetUpdatesBuf,
      writeGetUpdatesBuf: async (botId, buf) => {
        await repo.updateState((state) => {
          const current = state.bots[botId];
          return {
            ...state,
            bots: {
              ...state.bots,
              [botId]: {
                ...(current ?? {
                  botId,
                  workspacePath: "",
                  mode: "draft" as const,
                  activeTaskId: null,
                }),
                weixinGetUpdatesBuf: buf,
                updatedAt: now(),
              },
            },
          };
        });
      },
      handleInboundMessage: async (message, payload) => {
        // runtime 入站（官方 Yd 对齐）：逐条鉴权 → 管道 → ack（处理后/发送环前，TG answerCallbackQuery+清键盘）
        // → 发送环路由（Kt/Mt/en）→ stopInboundTyping（G）；回执不再只返回给调用方（否则 TG/飞书 WS 路径会被丢弃）
        const config = await repo.readConfig();
        if (!(await checkInboundAuth(config, message, payload))) {
          const locale = await resolveLocale();
          return [
            createOutbound(
              message.actor,
              formatBotMessage(locale, "webhookSecretInvalid"),
              undefined,
              { locale },
            ),
          ];
        }
        const outbounds = await pipeline.handleInboundMessage(message);
        const bot = await findBot(message.actor.botId).catch(() => null);
        if (bot) {
          const adapter = adapters.get(bot.provider);
          const syncCardAction =
            (bot.provider === "feishu" || bot.provider === "lark") &&
            isFeishuSynchronousCardAction(payload);
          const skipAck =
            syncCardAction ||
            (transientCards.has(transientCardKey(message.actor)) && !outbounds[0]?.elicitation);
          if (!skipAck && adapter) {
            await acknowledgeInboundCallback(bot, adapter, payload ?? {}, outbounds);
          }
          await routeCallbackReplies(bot, message.actor, message.text, outbounds);
          await stopInboundTyping(bot, message.actor);
        }
        return outbounds;
      },
      onStatus: onRuntimeStatus,
      logger,
      now,
    });
    if (options.runStartupBackgroundTasks !== false) void scheduleRefresh();
  }
  return service;
}

export type { BotDeliveryTarget };
