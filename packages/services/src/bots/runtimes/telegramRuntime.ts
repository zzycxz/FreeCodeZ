// Telegram 长轮询 runtime（附录B §3.1/§7）：getUpdates timeout 25s/HTTP 40s、409→10s、其他错 5s；
// 锁失败 idle+HandledElsewhere 10s 重试；锁异常 error+5s；offset=update_id+1 落盘（bot-state telegramOffset）；
// fingerprint（sha256(provider, credentialRef, secret)）变化重启 runtime。
import { createHash } from "node:crypto";
import type { BotConfig, InboundMessage } from "@zcode/shared/bots";
import type { ServiceLogger } from "../../logger/serviceLogger.js";
import {
  acquireBotRuntimeLock,
  hashBotRuntimeLockToken,
  type BotRuntimeLease,
} from "../fileLocks.js";
import type { BotRuntimeStatusEntry } from "../bots.js";

const GET_UPDATES_TIMEOUT_S = 25;
const HTTP_TIMEOUT_MS = 40_000;
const CONFLICT_BACKOFF_MS = 10_000;
const ERROR_BACKOFF_MS = 5_000;
const LOCK_RETRY_MS = 10_000;

export interface TelegramRuntimeDeps {
  fetchImpl: typeof fetch;
  apiBase: string;
  configDir: string;
  credentialLoader: (key: string) => Promise<string | null>;
  listBots: () => Promise<BotConfig[]>;
  readTelegramOffset: (botId: string) => Promise<number | undefined>;
  writeTelegramOffset: (botId: string, offset: number) => Promise<void>;
  /** 入站投递：payload=`{botId, update}`（官方 `processProviderCallback("telegram",{botId,update:D})` 形态）。 */
  handleInboundMessage: (message: InboundMessage, payload?: unknown) => Promise<unknown>;
  onStatus: (entry: BotRuntimeStatusEntry) => void;
  logger: ServiceLogger;
  now?: () => number;
}

interface TelegramLoop {
  botId: string;
  fingerprint: string;
  stopped: boolean;
  stop: () => void;
  lease: BotRuntimeLease | null;
}

export function computeTelegramFingerprint(bot: BotConfig, secret: string | null): string {
  return createHash("sha256")
    .update([bot.provider, bot.credentialRef ?? "", secret ?? ""].join("::"))
    .digest("hex");
}

export function createTelegramRuntime(deps: TelegramRuntimeDeps): {
  refresh: () => Promise<void>;
  disposeAll: () => Promise<void>;
} {
  const loops = new Map<string, TelegramLoop>();
  const now = deps.now ?? Date.now;

  const report = (
    bot: BotConfig,
    status: BotRuntimeStatusEntry["status"],
    messageId?: BotRuntimeStatusEntry["messageId"],
    extra: Partial<BotRuntimeStatusEntry> = {},
  ): void => {
    deps.onStatus({
      botId: bot.id,
      provider: "telegram",
      status,
      ...(messageId ? { messageId, message: messageId } : {}),
      lastUpdateAt: now(),
      ...extra,
    });
  };

  /** bot 启用时同步 setMyCommands（§3.1；失败仅告警，不阻断轮询）。 */
  const syncCommandsOnStartup = (bot: BotConfig, secret: string, loop: TelegramLoop): void => {
    void (async () => {
      try {
        const { syncTelegramMyCommands } = await import("../providers/telegramProvider.js");
        if (loop.stopped) return;
        await syncTelegramMyCommands(deps.fetchImpl, deps.apiBase, secret, bot);
      } catch (error) {
        deps.logger.warn(
          undefined,
          `sync Telegram commands failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
  };

  const runLoop = async (bot: BotConfig, secret: string, loop: TelegramLoop): Promise<void> => {
    let offset = (await deps.readTelegramOffset(bot.id)) ?? 0;
    while (!loop.stopped) {
      let lease = loop.lease;
      if (!lease) {
        lease = await acquireBotRuntimeLock({
          configDir: deps.configDir,
          kind: "telegram-polling",
          token: secret,
          botId: bot.id,
        });
        loop.lease = lease;
        if (!lease) {
          // 拿锁失败→idle + HandledElsewhere，10s 重试
          report(bot, "idle", "bots.runtime.telegramLongPollingHandledElsewhere");
          await sleep(LOCK_RETRY_MS);
          continue;
        }
        report(bot, "polling", "bots.runtime.telegramLongPollingRunning", { offset });
        // bot 启用时同步命令表（§3.1 setMyCommands，官方 runtime 启动接线）
        void syncCommandsOnStartup(bot, secret, loop);
      }
      try {
        const updates = await callGetUpdates(deps, secret, offset);
        for (const update of updates) {
          const parsed = await parseUpdate(deps, bot, update);
          for (const message of parsed) {
            // 官方 Yd 形态传原始 update（answerCallbackQuery/清键盘经 nce/rce 提取 callback_query）
            await deps.handleInboundMessage(message, { botId: bot.id, update });
          }
          const updateId = (update as { update_id?: number }).update_id;
          if (typeof updateId === "number") offset = updateId + 1;
        }
        await deps.writeTelegramOffset(bot.id, offset);
        report(bot, "polling", "bots.runtime.telegramLongPollingRunning", { offset });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/409|already used by another polling client/iu.test(message)) {
          report(bot, "error", "bots.runtime.telegramPollingFailedRetrying", {
            deliveryError: message,
          });
          await sleep(CONFLICT_BACKOFF_MS);
          continue;
        }
        if (/lock/iu.test(message)) {
          report(bot, "idle", "bots.runtime.telegramLongPollingHandledElsewhere");
          await sleep(ERROR_BACKOFF_MS);
          continue;
        }
        deps.logger.warn(undefined, `telegram polling failed bot=${bot.id}: ${message}`);
        report(bot, "error", "bots.runtime.telegramPollingFailedRetrying", {
          deliveryError: message,
        });
        await sleep(ERROR_BACKOFF_MS);
      }
    }
  };

  return {
    async refresh() {
      const bots = await deps.listBots();
      for (const bot of bots) {
        const secret = bot.credentialRef ? await deps.credentialLoader(bot.credentialRef) : null;
        const existing = loops.get(bot.id);
        if (!bot.enabled || !secret) {
          report(bot, bot.enabled ? "error" : "disabled", "bots.runtime.telegramTokenMissing");
          existing?.stop();
          loops.delete(bot.id);
          continue;
        }
        const fingerprint = computeTelegramFingerprint(bot, secret);
        if (existing && existing.fingerprint === fingerprint && !existing.stopped) continue;
        existing?.stop();
        const loop: TelegramLoop = {
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
        report(bot, "polling", "bots.runtime.telegramLongPollingStarting");
        void runLoop(bot, secret, loop).catch((error: unknown) => {
          deps.logger.warn(
            undefined,
            `telegram runtime exited bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
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

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}

async function callGetUpdates(
  deps: TelegramRuntimeDeps,
  token: string,
  offset: number,
): Promise<unknown[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await deps.fetchImpl(`${deps.apiBase}/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        timeout: GET_UPDATES_TIMEOUT_S,
        ...(offset > 0 ? { offset } : {}),
        allowed_updates: ["message", "callback_query"],
      }),
      signal: controller.signal,
    });
    if (response.status === 409) {
      throw new Error("409: token is already used by another polling client");
    }
    const result = (await response.json()) as { ok?: boolean; result?: unknown[] };
    return Array.isArray(result.result) ? result.result : [];
  } finally {
    clearTimeout(timer);
  }
}

async function parseUpdate(
  deps: TelegramRuntimeDeps,
  bot: BotConfig,
  update: unknown,
): Promise<InboundMessage[]> {
  const { parseTelegramMessage, parseTelegramCallbackQuery } = await import(
    "../providers/telegramProvider.js"
  );
  const record = (update ?? {}) as Record<string, unknown>;
  const messages: InboundMessage[] = [];
  if (record.message) {
    const parsed = parseTelegramMessage(bot.id, record.message as Record<string, unknown>);
    if (parsed) messages.push(parsed);
  }
  if (record.callback_query) {
    const parsed = parseTelegramCallbackQuery(bot.id, record.callback_query as Record<string, unknown>);
    if (parsed) messages.push(parsed);
  }
  void deps;
  return messages;
}

export { hashBotRuntimeLockToken };
