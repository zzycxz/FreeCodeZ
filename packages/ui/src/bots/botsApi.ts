/**
 * botsService 访问封装（附录B §4.1 channel "bots" 的 renderer 调用面）。
 *
 * services 侧接口由并行任务落地；这里按 UI 实际消费面收窄结构形状，
 * 缺失类型用本地结构类型解耦，避免 UI 反向依赖 services 内部实现。
 */
import { nanoid } from "nanoid";
import type { BotConfig, BotProvider, BotsConfigV3, ReplyModeOption } from "@zcode/shared/bots";
import { listReplyModeOptions, normalizeBotCommandPolicy } from "@zcode/shared/bots";
import { useOptionalServices } from "@/hooks/useServices.js";

/** 运行状态行（getStatus().botRuntime[]）。messageId 是 host 侧回复文案 key，UI 负责翻译。 */
export interface BotRuntimeView {
  botId: string;
  provider: string;
  status: "polling" | "connected" | "idle" | "error" | "disabled";
  message?: string;
  messageId?: `bots.runtime.${string}`;
  offset?: number;
  deliveryError?: string;
  lastUpdateAt?: number;
}

export interface BotsStatusView {
  botsCount: number;
  enabledBotsCount: number;
  contextsCount: number;
  botRuntime: BotRuntimeView[];
}

export interface BotWorkspaceRef {
  id: string;
  label: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface BotStateView {
  botId: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  providerUserId?: string;
  weixinActivatedAt?: number;
  updatedAt?: number;
}

export interface BotBindCodeView {
  code: string;
  expiresAt: number;
}

export interface FeishuRegistrationBegin {
  deviceCode: string;
  qrUrl: string;
  userCode?: string;
  interval: number;
  expiresAt: number;
  domain: "feishu" | "lark";
  pollDomain?: string;
}

export type FeishuRegistrationPoll =
  | { status: "pending"; interval?: number; domain?: string; pollDomain?: string }
  | { status: "success"; appId: string; appSecret: string; appName?: string; openId?: string }
  | { status: "access_denied" | "expired" | "error"; message?: string };

export interface WeixinRegistrationBegin {
  qrCode: string;
  qrUrl: string;
  interval: number;
  expiresAt: number;
}

export type WeixinRegistrationPoll =
  | { status: "pending" | "scanned"; interval?: number }
  | { status: "success"; botToken: string; botId?: string }
  | { status: "expired" | "error"; message?: string };

export interface BotsServiceApi {
  getConfig(): Promise<BotsConfigV3>;
  saveConfig(config: BotsConfigV3): Promise<BotsConfigV3>;
  listBots(): Promise<BotConfig[]>;
  getStatus(): Promise<BotsStatusView>;
  getBotStates(): Promise<BotStateView[]>;
  listWorkspaceRefs(params?: { currentWorkspace?: BotWorkspaceRef }): Promise<BotWorkspaceRef[]>;
  saveBot(params: {
    bot: BotConfig;
    credentialValue?: string;
    webhookSecretValue?: string;
  }): Promise<BotConfig>;
  removeBotSecret(botId: string): Promise<BotConfig>;
  deleteBot(botId: string): Promise<void>;
  testBot(
    botId: string,
  ): Promise<{ ok: boolean; name?: string; message: string; provider: string }>;
  createBindCode(params: {
    botId: string;
    ttlMs?: number;
    allowedWorkspaces?: string[];
  }): Promise<BotBindCodeView>;
  resetBotState(botId: string): Promise<void>;
  beginFeishuRegistration(params?: {
    domain?: "feishu" | "lark";
  }): Promise<FeishuRegistrationBegin>;
  pollFeishuRegistration(params: {
    deviceCode: string;
    domain?: string;
    pollDomain?: string;
  }): Promise<FeishuRegistrationPoll>;
  beginWeixinRegistration(): Promise<WeixinRegistrationBegin>;
  pollWeixinRegistration(params: { qrCode: string }): Promise<WeixinRegistrationPoll>;
}

/** 未接入 botsService 的宿主（Web/旧 wire）返回 null，调用方降级为只读空态。 */
export function useBotsService(): BotsServiceApi | null {
  const services = useOptionalServices();
  const candidate = (services as { botsService?: unknown } | null)?.botsService;
  return (candidate as BotsServiceApi | undefined) ?? null;
}

/** 飞书/Lark 共用扫码注册链路（附录C §1.3 `pi`）。 */
export function isFeishuLikeProvider(provider: BotProvider | string): boolean {
  return provider === "feishu" || provider === "lark";
}

/** 展示名兜底（附录C §1.3 `b3`）：空名回落"新机器人"。 */
export function resolveBotDisplayName(name: string, fallback: string): string {
  return name.trim() || fallback;
}

export function createEmptyBotsConfig(): BotsConfigV3 {
  return { version: 3, bots: [] };
}

/** 新建 bot 默认值（附录C §1.3 `rin`）：全命令开启、所有工作区、默认颗粒度取渠道首档。 */
export function createDefaultBot(params: { provider: BotProvider }): BotConfig {
  const replyModes = listReplyModeOptions(params.provider);
  return {
    id: `bot-${nanoid()}`,
    name: "",
    provider: params.provider,
    enabled: true,
    allowedWorkspaces: ["*"],
    allowedCommands: normalizeBotCommandPolicy({
      status: true,
      new: true,
      workspace: true,
      model: true,
      mode: true,
      thoughtLevel: true,
      reply: true,
    }),
    currentOptions: {},
    replyMode: replyModes[0]?.mode ?? "assistant_changes",
  };
}

/** 渠道当前可用颗粒度（feishu/lark 只有流式卡片一档）。 */
export function listBotReplyModes(provider: BotProvider | string) {
  return listReplyModeOptions(provider);
}

/** 当前颗粒度选项；非法值回落首档（附录C §1.5 `Nrn`）。 */
export function resolveBotReplyModeOption(
  provider: BotProvider | string,
  replyMode: string,
): ReplyModeOption {
  const options = listReplyModeOptions(provider);
  return options.find((option) => option.mode === replyMode) ?? options[0]!;
}
