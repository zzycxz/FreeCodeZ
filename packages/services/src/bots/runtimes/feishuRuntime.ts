// 飞书/Lark WS runtime（附录B §3.3/§7）：@larksuiteoapi/node-sdk WSClient + EventDispatcher；
// im.message.receive_v1 注入 botId 转 handleProviderCallback；card.action.trigger 同步返回 {card:{type:'raw',data}}
// 并把 behaviors[0].value.command 当文本命令入队；启动 20s 超时/100ms 就绪探测；掉线 reconnecting，
// isConnecting===false 抛 "reconnect exhausted"；锁 feishu-websocket|lark-websocket（token=feishuAppId）。
import { createHash } from "node:crypto";
import type { BotConfig, BotProvider, InboundMessage } from "@zcode/shared/bots";
import type { ServiceLogger } from "../../logger/serviceLogger.js";
import { acquireBotRuntimeLock, type BotRuntimeLease } from "../fileLocks.js";
import type { BotRuntimeStatusEntry } from "../bots.js";
import { decodeTelegramCallbackData } from "@zcode/shared/bots";

const WS_STARTUP_TIMEOUT_MS = 20_000;
const WS_READY_PROBE_MS = 100;
const ERROR_BACKOFF_MS = 5_000;
const LOCK_RETRY_MS = 10_000;

export interface FeishuRuntimeDeps {
  configDir: string;
  credentialLoader: (key: string) => Promise<string | null>;
  listBots: () => Promise<BotConfig[]>;
  handleInboundMessage: (message: InboundMessage, payload?: unknown) => Promise<unknown>;
  onStatus: (entry: BotRuntimeStatusEntry) => void;
  logger: ServiceLogger;
  now?: () => number;
  /** 注入以供测试；缺省动态加载 @larksuiteoapi/node-sdk。 */
  loadLarkSdk?: () => Promise<LarkSdkLike>;
}

/** 最小 WSClient/EventDispatcher 面（真实 SDK 结构兼容）。 */
export interface LarkSdkLike {
  WSClient: new (config: {
    appId: string;
    appSecret: string;
    domain?: string;
    loggerLevel?: string;
  }) => {
    start: () => Promise<{ close?: () => Promise<void> } | void> | { close?: () => Promise<void> } | void;
    stop?: () => void;
    isConnecting?: () => boolean;
  };
  EventDispatcher: new (params?: Record<string, unknown>) => {
    register: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK 事件面按需注册
      im: any;
      card: { action: { trigger: (handler: (event: unknown) => unknown) => void } };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK builder 兼容
    [key: string]: any;
  };
  Domain?: { Lark?: string; Feishu?: string };
}

interface FeishuLoop {
  botId: string;
  fingerprint: string;
  stopped: boolean;
  stop: () => void;
  lease: BotRuntimeLease | null;
}

export function computeFeishuFingerprint(bot: BotConfig, secret: string | null): string {
  return createHash("sha256")
    .update([bot.provider, bot.credentialRef ?? "", secret ?? "", bot.feishuAppId ?? ""].join("::"))
    .digest("hex");
}

async function defaultLoadLarkSdk(): Promise<LarkSdkLike> {
  const specifier = "@larksuiteoapi/node-sdk";
  return (await import(specifier)) as unknown as LarkSdkLike;
}

export function createFeishuRuntime(deps: FeishuRuntimeDeps): {
  refresh: () => Promise<void>;
  disposeAll: () => Promise<void>;
} {
  const loops = new Map<string, FeishuLoop>();
  const now = deps.now ?? Date.now;
  const loadSdk = deps.loadLarkSdk ?? defaultLoadLarkSdk;

  const report = (
    bot: BotConfig,
    status: BotRuntimeStatusEntry["status"],
    messageId?: BotRuntimeStatusEntry["messageId"],
    extra: Partial<BotRuntimeStatusEntry> = {},
  ): void => {
    deps.onStatus({
      botId: bot.id,
      provider: bot.provider as BotProvider,
      status,
      ...(messageId ? { messageId, message: messageId } : {}),
      lastUpdateAt: now(),
      ...extra,
    });
  };

  const runLoop = async (bot: BotConfig, secret: string, loop: FeishuLoop): Promise<void> => {
    while (!loop.stopped) {
      if (!loop.lease) {
        const lease = await acquireBotRuntimeLock({
          configDir: deps.configDir,
          kind: bot.provider === "lark" ? "lark-websocket" : "feishu-websocket",
          token: bot.feishuAppId ?? secret,
          botId: bot.id,
        });
        loop.lease = lease;
        if (!lease) {
          report(bot, "idle", "bots.runtime.feishuWebSocketStopped");
          await sleep(LOCK_RETRY_MS);
          continue;
        }
      }
      try {
        report(bot, "connected", "bots.runtime.feishuWebSocketConnecting");
        const sdk = await loadSdk();
        const dispatcher = new sdk.EventDispatcher({});
        // im.message.receive_v1：注入 botId 后走统一入站管道
        dispatcher.register.im = {
          message: {
            receiveV1: async (event: unknown) => {
              const messages = await parseFeishuEvent(bot, event);
              for (const message of messages) {
                // 原始事件随 payload 下传（飞书族 Verification Token 校验 / ack 提取 card token）
                await deps.handleInboundMessage(message, event);
              }
            },
          },
          reaction: {
            createdV1: async () => {
              // reaction（typing）no-op
            },
          },
        };
        // card.action.trigger：同步返回 raw 卡；按钮 command 当文本命令
        dispatcher.register.card?.action?.trigger?.(async (event: unknown) => {
          const command = extractCardCommand(event);
          if (command) {
            const message = buildCardActionMessage(bot, event, command);
            if (message) {
              // 官方 card.action.trigger 载荷带 zcodeFeishuSynchronousCardAction（ack 短路判定）
              await deps.handleInboundMessage(message, {
                botId: bot.id,
                zcodeProvider: bot.provider,
                zcodeFeishuSynchronousCardAction: true,
                ...((typeof event === "object" && event !== null && !Array.isArray(event)
                  ? event
                  : { payload: event }) as Record<string, unknown>),
              });
            }
          }
          return { card: { type: "raw", data: {} } };
        });
        const client = new sdk.WSClient({
          appId: bot.feishuAppId ?? "",
          appSecret: secret,
          domain: bot.provider === "lark" ? sdk.Domain?.Lark : sdk.Domain?.Feishu,
          loggerLevel: "warn",
        });
        const started = await Promise.race([
          Promise.resolve(client.start()).then(() => "started" as const),
          sleep(WS_STARTUP_TIMEOUT_MS).then(() => "timeout" as const),
        ]);
        if (started === "timeout") throw new Error("Feishu WS startup timed out.");
        await sleep(WS_READY_PROBE_MS);
        report(bot, "connected", "bots.runtime.feishuWebSocketRunning");
        while (!loop.stopped) {
          await sleep(WS_READY_PROBE_MS * 5);
          if (client.isConnecting && client.isConnecting() === false) {
            throw new Error("reconnect exhausted");
          }
        }
        client.stop?.();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.warn(undefined, `feishu ws failed bot=${bot.id}: ${message}`);
        report(bot, "error", "bots.runtime.feishuWebSocketStopped", { deliveryError: message });
        await sleep(ERROR_BACKOFF_MS);
      }
    }
  };

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  return {
    async refresh() {
      const bots = (await deps.listBots()).filter(
        (bot) => bot.provider === "feishu" || bot.provider === "lark",
      );
      for (const bot of bots) {
        const secret = bot.credentialRef ? await deps.credentialLoader(bot.credentialRef) : null;
        const existing = loops.get(bot.id);
        if (!bot.enabled || !secret || !bot.feishuAppId) {
          report(bot, bot.enabled ? "error" : "disabled", "bots.runtime.botDisabled");
          existing?.stop();
          loops.delete(bot.id);
          continue;
        }
        const fingerprint = computeFeishuFingerprint(bot, secret);
        if (existing && existing.fingerprint === fingerprint && !existing.stopped) continue;
        existing?.stop();
        const loop: FeishuLoop = {
          botId: bot.id,
          fingerprint,
          stopped: false,
          stop: () => {
            loop.stopped = true;
            void loop.lease?.release();
            loop.lease = null;
          },
          lease: null,
        };
        loops.set(bot.id, loop);
        report(bot, "connected", "bots.runtime.feishuWebSocketStarting");
        void runLoop(bot, secret, loop).catch((error: unknown) => {
          deps.logger.warn(
            undefined,
            `feishu runtime exited bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      for (const [botId, loop] of loops) {
        if (!bots.some((bot) => bot.id === botId)) {
          loop.stop();
          loops.delete(botId);
        }
      }
    },
    async disposeAll() {
      for (const loop of loops.values()) loop.stop();
      loops.clear();
    },
  };
}

async function parseFeishuEvent(bot: BotConfig, event: unknown): Promise<InboundMessage[]> {
  const { parseFeishuMessageEvent } = await import("../providers/feishuProvider.js");
  return parseFeishuMessageEvent(bot.id, event);
}

/** 卡片按钮 behaviors[0].value.command → 文本命令（decodeTelegramCallbackData 兼容 zc:*）。 */
export function extractCardCommand(event: unknown): string | null {
  const root = (event ?? {}) as Record<string, unknown>;
  const action = (root.action ?? root) as Record<string, unknown>;
  const value = (action.value ?? {}) as Record<string, unknown>;
  const command = typeof value.command === "string" ? value.command : null;
  if (!command) return null;
  return command.startsWith("zc:") ? decodeTelegramCallbackData(command) : command;
}

function buildCardActionMessage(
  bot: BotConfig,
  event: unknown,
  text: string,
): InboundMessage | null {
  const root = (event ?? {}) as Record<string, unknown>;
  const operator = (root.operator ?? {}) as Record<string, unknown>;
  const openId = typeof operator.open_id === "string" ? operator.open_id : undefined;
  if (!openId) return null;
  const contextToken = typeof root.open_message_id === "string" ? root.open_message_id : undefined;
  return {
    botId: bot.id,
    text,
    actor: {
      provider: bot.provider as "feishu" | "lark",
      botId: bot.id,
      providerUserId: openId,
      chatType: "private",
      ...(contextToken ? { providerContextToken: contextToken } : {}),
    },
  };
}
