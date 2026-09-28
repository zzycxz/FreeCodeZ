// Bots 服务接口层（附录B §4.1，channel "bots"，23 签名）+ 渠道适配器契约。
// 命令文法/callback 编解码/持久化 schema/消息形状来自 @zcode/shared/bots（已定稿，不重复实现）。
import { ServiceChannels } from "@zcode/shared";
import type {
  BotActor,
  BotAttachment,
  BotConfig,
  BotContext,
  BotDeliveryTarget,
  BotProvider,
  BotsConfigV3,
  InboundMessage,
  OutboundMessage,
} from "@zcode/shared/bots";
import { createServiceDescriptor } from "../descriptors.js";

/** getStatus 的 botRuntime 行（UI 2s 轮询消费）。 */
export interface BotRuntimeStatusEntry {
  botId: string;
  provider: BotProvider;
  status: "polling" | "connected" | "idle" | "error" | "disabled";
  message?: string;
  messageId?: `bots.runtime.${string}`;
  offset?: number;
  deliveryError?: string;
  lastUpdateAt: number;
}

export interface BotsStatus {
  botsCount: number;
  enabledBotsCount: number;
  contextsCount: number;
  botRuntime: BotRuntimeStatusEntry[];
}

export interface BotWorkspaceRef {
  id?: string;
  label: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remote?: boolean;
}

export interface BotTestResult {
  ok: boolean;
  name?: string;
  message: string;
  provider: BotProvider;
}

export interface FeishuRegistrationBegin {
  deviceCode: string;
  qrUrl: string;
  userCode?: string;
  interval: number;
  expiresAt: number;
  domain: "feishu" | "lark";
  pollDomain?: "feishu" | "lark";
}

export type FeishuRegistrationPoll =
  | { status: "pending" }
  | { status: "success"; appId: string; appSecret: string; appName?: string; openId?: string }
  | { status: "access_denied" }
  | { status: "expired" }
  | { status: "error"; message: string };

export interface WeixinRegistrationBegin {
  qrCode: string;
  qrUrl: string;
  interval: 3;
  expiresAt: number;
}

export type WeixinRegistrationPoll =
  | { status: "pending" }
  | { status: "scanned" }
  | { status: "success"; botToken: string; botId?: string }
  | { status: "expired" }
  | { status: "error"; message: string };

export interface BotCallbackResponse {
  ok: boolean;
  replies: OutboundMessage[];
  status?: number;
  responseBody?: unknown;
}

/** 飞书 transient 交互卡句柄（POST /open-apis/im/v1/messages 返回的 message_id）。 */
export interface BotTransientCardHandle {
  providerMessageId: string;
}

export interface SaveBotParams {
  bot: BotConfig;
  credentialValue?: string;
  webhookSecretValue?: string;
}

export interface CreateBindCodeParams {
  botId: string;
  ttlMs?: number;
  allowedWorkspaces?: string[];
}

export interface CreateBindCodeResult {
  code: string;
  expiresAt: number;
}

export interface WatchAutomationRunParams {
  target: BotDeliveryTarget;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * 渠道适配器（providers/*）：出站渲染、入站解析、连通性测试、凭据解析名。
 * acknowledgeCallback / prepareCallbackPayload 为官方死扩展点（0 实现），保留可选。
 */
export interface BotProviderAdapter {
  readonly provider: BotProvider;
  send(bot: BotConfig, outbound: OutboundMessage): Promise<void>;
  test(bot: BotConfig, credential: string | null): Promise<BotTestResult>;
  /** getMe / app 显示名；失败可抛错（saveBot resolveName 会按渠道重试表重试）。 */
  resolveName?(bot: BotConfig, credential: string | null): Promise<string | undefined>;
  /** 渠道入站 payload → 标准 InboundMessage 列表（token 校验在 pipeline）。 */
  parseCallback(
    bot: BotConfig | null,
    payload: unknown,
    secret: string | null,
  ): Promise<{ ok: boolean; messages: InboundMessage[]; status?: number; body?: unknown }>;
  /** typing 心跳（TG sendChatAction / 微信 sendtyping / 飞书 reaction）；无实现则跳过。 */
  sendTyping?(bot: BotConfig, actor: BotActor): Promise<void>;
  /** 官方 startTyping：有实现则一次挂载（飞书 reaction 去重）；无实现回落 sendTyping 4000ms 重发（Nle=4e3）。 */
  startTyping?(bot: BotConfig, actor: BotActor): Promise<void>;
  /** 官方 stopTyping：取消 typing 指示（飞书 DELETE reaction）；任务终态 K / 入站收口 G 触发。 */
  stopTyping?(bot: BotConfig, actor: BotActor): Promise<void>;
  /** TG setMyCommands 同步（enabled=false → deleteMyCommands；saveBot/停用/deleteBot/removeBotSecret 接线）。 */
  syncCommands?(bot: BotConfig): Promise<void>;
  /** transient 交互卡三段式（附录B §2.4）：POST 创建，返回 message_id 句柄。 */
  createTransientInteractionCard?(
    bot: BotConfig,
    outbound: OutboundMessage,
  ): Promise<BotTransientCardHandle | null>;
  /** transient 交互卡 PATCH `/open-apis/im/v1/messages/{id}`：点按钮刷新 + 收口 PATCH 终态卡（finalizeTransientInteractionCard）。 */
  updateTransientInteractionCard?(
    bot: BotConfig,
    handle: BotTransientCardHandle,
    outbound: OutboundMessage,
  ): Promise<void>;
  /** 官方 deleteTransientInteractionCard：host 全构建仅定义、无任何调用点（收口不撤回卡）。保留可选。 */
  deleteTransientInteractionCard?(bot: BotConfig, handle: BotTransientCardHandle): Promise<void>;
  /** 渠道私有附件下载（TG getFile / 飞书资源 / 微信 CDN 解密）。 */
  downloadAttachment?(
    bot: BotConfig,
    attachment: BotAttachment,
    actor: BotActor,
  ): Promise<{ attachment: BotAttachment; data: Uint8Array } | null>;
  /** 入站已处理后的渠道回执（answerCallbackQuery / 卡片回执 / 200 OK）。 */
  acknowledgeCallback?(
    bot: BotConfig,
    payload: unknown,
    text: string,
    firstReply: OutboundMessage | undefined,
    signal?: AbortSignal,
  ): Promise<{ handled?: boolean } | undefined>;
}

export interface IBotsService {
  /** 应用 runtime 偏好同步钩子（官方保留签名）。 */
  syncAppRuntimePreferences(h?: unknown): Promise<void>;
  getStatus(): Promise<BotsStatus>;
  getConfig(): Promise<BotsConfigV3>;
  listWorkspaceRefs(h?: { currentWorkspace?: BotWorkspaceRef }): Promise<BotWorkspaceRef[]>;
  /** 官方恒空 stub（保留签名）。 */
  getUserConfigOptions(h?: unknown): Promise<[]>;
  beginFeishuRegistration(h?: { domain?: "feishu" | "lark" }): Promise<FeishuRegistrationBegin>;
  pollFeishuRegistration(h: {
    deviceCode: string;
    domain?: "feishu" | "lark";
    pollDomain?: "feishu" | "lark";
  }): Promise<FeishuRegistrationPoll>;
  beginWeixinRegistration(): Promise<WeixinRegistrationBegin>;
  pollWeixinRegistration(h: { qrcode: string }): Promise<WeixinRegistrationPoll>;
  saveConfig(h: BotsConfigV3): Promise<BotsConfigV3>;
  listBots(): Promise<BotConfig[]>;
  saveBot(h: SaveBotParams): Promise<BotConfig>;
  removeBotSecret(h: { botId: string }): Promise<BotConfig>;
  deleteBot(h: { botId: string }): Promise<void>;
  testBot(h: { botId: string }): Promise<BotTestResult>;
  createBindCode(h: CreateBindCodeParams): Promise<CreateBindCodeResult>;
  getBotStates(): Promise<BotContext[]>;
  resetBotState(h: { botId: string }): Promise<void>;
  watchAutomationRun(h: WatchAutomationRunParams): Promise<void>;
  handleInboundMessage(h: InboundMessage): Promise<OutboundMessage[]>;
  handleProviderCallback(provider: BotProvider, payload: unknown): Promise<OutboundMessage[]>;
  handleProviderCallbackResponse(
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotCallbackResponse>;
  disposeAll(): void;
  disposeAllAndWait(): Promise<void>;
}

export const IBotsService = createServiceDescriptor<IBotsService>(ServiceChannels.Bots);
