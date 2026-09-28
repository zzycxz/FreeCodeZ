// 微信 iLink 长轮询 runtime（附录B §3.2/§7）：getupdates 90s 游标（weixinGetUpdatesBuf 落盘，6 键 fallback）；
// 锁失败 idle+HandledElsewhere 10s 重试；错误 5s；fingerprint 变化重启。
import { createHash, randomInt, randomUUID } from "node:crypto";
import type { BotConfig, InboundMessage } from "@zcode/shared/bots";
import type { ServiceLogger } from "../../logger/serviceLogger.js";
import { acquireBotRuntimeLock, type BotRuntimeLease } from "../fileLocks.js";
import type { BotRuntimeStatusEntry } from "../bots.js";
import { extractWeixinUpdatesCursor, parseWeixinUpdates, WEIXIN_API_BASE } from "../providers/weixinProvider.js";

const GET_UPDATES_TIMEOUT_MS = 90_000;
const ERROR_BACKOFF_MS = 5_000;
const LOCK_RETRY_MS = 10_000;

export interface WeixinRuntimeDeps {
  fetchImpl: typeof fetch;
  apiBase?: string;
  configDir: string;
  credentialLoader: (key: string) => Promise<string | null>;
  listBots: () => Promise<BotConfig[]>;
  readGetUpdatesBuf: (botId: string) => Promise<string | undefined>;
  writeGetUpdatesBuf: (botId: string, buf: string) => Promise<void>;
  handleInboundMessage: (message: InboundMessage, payload?: unknown) => Promise<unknown>;
  onStatus: (entry: BotRuntimeStatusEntry) => void;
  logger: ServiceLogger;
  now?: () => number;
}

interface WeixinLoop {
  botId: string;
  fingerprint: string;
  stopped: boolean;
  stop: () => void;
  lease: BotRuntimeLease | null;
}

export function computeWeixinFingerprint(bot: BotConfig, secret: string | null): string {
  return createHash("sha256")
    .update([bot.provider, bot.credentialRef ?? "", secret ?? ""].join("::"))
    .digest("hex");
}

export function createWeixinRuntime(deps: WeixinRuntimeDeps): {
  refresh: () => Promise<void>;
  disposeAll: () => Promise<void>;
} {
  const loops = new Map<string, WeixinLoop>();
  const apiBase = deps.apiBase ?? WEIXIN_API_BASE;
  const now = deps.now ?? Date.now;

  const report = (
    bot: BotConfig,
    status: BotRuntimeStatusEntry["status"],
    messageId?: BotRuntimeStatusEntry["messageId"],
    extra: Partial<BotRuntimeStatusEntry> = {},
  ): void => {
    deps.onStatus({
      botId: bot.id,
      provider: "weixin",
      status,
      ...(messageId ? { messageId, message: messageId } : {}),
      lastUpdateAt: now(),
      ...extra,
    });
  };

  const runLoop = async (bot: BotConfig, secret: string, loop: WeixinLoop): Promise<void> => {
    let cursor = (await deps.readGetUpdatesBuf(bot.id)) ?? "";
    while (!loop.stopped) {
      if (!loop.lease) {
        const lease = await acquireBotRuntimeLock({
          configDir: deps.configDir,
          kind: "weixin-polling",
          token: secret,
          botId: bot.id,
        });
        loop.lease = lease;
        if (!lease) {
          report(bot, "idle", "bots.runtime.weixinLongPollingStopped");
          await sleep(LOCK_RETRY_MS);
          continue;
        }
        report(bot, "polling", "bots.runtime.weixinLongPollingRunning");
      }
      try {
        const result = await callGetUpdates(bot, secret, cursor);
        for (const message of parseWeixinUpdates(bot.id, result)) {
          await deps.handleInboundMessage(message, { botId: bot.id });
        }
        const nextCursor = extractWeixinUpdatesCursor(result);
        if (nextCursor !== undefined && nextCursor !== cursor) {
          cursor = nextCursor;
          await deps.writeGetUpdatesBuf(bot.id, cursor);
        }
        report(bot, "polling", "bots.runtime.weixinLongPollingRunning");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.warn(undefined, `weixin polling failed bot=${bot.id}: ${message}`);
        report(bot, "error", "bots.runtime.weixinLongPollingStopped", { deliveryError: message });
        await sleep(ERROR_BACKOFF_MS);
      }
    }
  };

  const callGetUpdates = async (
    bot: BotConfig,
    token: string,
    cursor: string,
  ): Promise<Record<string, unknown>> => {
    const response = await deps.fetchImpl(`${apiBase}/ilink/bot/getupdates`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${token}`,
        "X-WECHAT-UIN": Buffer.from(String(randomInt(0, 2 ** 32))).toString("base64"),
      },
      body: JSON.stringify({
        base_info: { channel_version: "2.0.0" },
        get_updates_buf: cursor,
        client_id: `zcode-weixin-${randomUUID()}`,
      }),
      signal: AbortSignal.timeout(GET_UPDATES_TIMEOUT_MS),
    });
    const result = (await response.json()) as Record<string, unknown>;
    if ((result.ret !== undefined && result.ret !== 0) || (result.errcode !== undefined && result.errcode !== 0)) {
      throw new Error(String(result.errmsg ?? result.message ?? "weixin getupdates failed"));
    }
    void bot;
    return result;
  };

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  return {
    async refresh() {
      const bots = (await deps.listBots()).filter((bot) => bot.provider === "weixin");
      for (const bot of bots) {
        const secret = bot.credentialRef ? await deps.credentialLoader(bot.credentialRef) : null;
        const existing = loops.get(bot.id);
        if (!bot.enabled || !secret) {
          report(bot, bot.enabled ? "error" : "disabled", "bots.runtime.botDisabled");
          existing?.stop();
          loops.delete(bot.id);
          continue;
        }
        const fingerprint = computeWeixinFingerprint(bot, secret);
        if (existing && existing.fingerprint === fingerprint && !existing.stopped) continue;
        existing?.stop();
        const loop: WeixinLoop = {
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
        report(bot, "polling", "bots.runtime.weixinLongPollingStarting");
        void runLoop(bot, secret, loop).catch((error: unknown) => {
          deps.logger.warn(
            undefined,
            `weixin runtime exited bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
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
