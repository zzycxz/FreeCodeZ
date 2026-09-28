// Telegram 渠道（附录B §3.1/§2.4）：getMe/setMyCommands/sendMessage（Markdown 降级、3900 切片、
// 仅末片带 inline_keyboard）/answerCallbackQuery（180 截断）/editMessageReplyMarkup/getFile 下载 30s。
// callback_query.data 经 decodeTelegramCallbackData 还原为文本命令。
import {
  buildSelectionCallbackData,
  decodeTelegramCallbackData,
  type BotActor,
  type BotAttachment,
  type BotConfig,
  type InboundMessage,
  type OutboundMessage,
} from "@zcode/shared/bots";
import type { BotProviderAdapter, BotTestResult } from "../bots.js";
import { truncateText, formatSelectionFallback, normalizeInlineText } from "../replyPipeline.js";

export const TELEGRAM_API_BASE = "https://api.telegram.org";
export const TELEGRAM_SLICE_LIMIT = 3900;
export const TELEGRAM_TOAST_LIMIT = 180;
const TELEGRAM_HTTP_TIMEOUT_MS = 15_000;
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** truncateCallbackToast（Jae）：trim+空白折叠后 180 截断（177 + `...`）。 */
export function truncateCallbackToast(text: string): string {
  return truncateText(normalizeInlineText(text), TELEGRAM_TOAST_LIMIT);
}

/** readTelegramCallbackId（nce）：`payload.update ?? payload` → callback_query.id。 */
export function readTelegramCallbackId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const update = isRecord(payload.update) ? payload.update : payload;
  const query = isRecord(update.callback_query) ? update.callback_query : null;
  return typeof query?.id === "string" ? query.id : null;
}

/** readTelegramCallbackMessageRef（rce）：callback_query.message → {chatId, messageId}；message_id 仅认 number。 */
export function readTelegramCallbackMessageRef(
  payload: unknown,
): { chatId: string; messageId: number } | null {
  if (!isRecord(payload)) return null;
  const update = isRecord(payload.update) ? payload.update : payload;
  const query = isRecord(update.callback_query) ? update.callback_query : null;
  const message = isRecord(query?.message) ? query.message : null;
  const chat = isRecord(message?.chat) ? message.chat : null;
  const chatId =
    typeof chat?.id === "number" || typeof chat?.id === "string" ? String(chat.id) : "";
  const messageId = typeof message?.message_id === "number" ? message.message_id : null;
  return chatId && messageId !== null ? { chatId, messageId } : null;
}

/** setMyCommands 映射（§3.1）：workspace→project、thoughtLevel→think；help/bind 恒在。 */
export const TELEGRAM_COMMAND_MAP: ReadonlyArray<{ command: string; description: string; policyKey?: string }> = [
  { command: "bind", description: "Bind this chat" },
  { command: "help", description: "Show commands" },
  { command: "status", description: "Show status", policyKey: "status" },
  { command: "new", description: "Start a new task", policyKey: "new" },
  { command: "project", description: "Switch workspace", policyKey: "workspace" },
  { command: "model", description: "Switch model", policyKey: "model" },
  { command: "mode", description: "Switch run mode", policyKey: "mode" },
  { command: "think", description: "Switch thought level", policyKey: "thoughtLevel" },
  { command: "reply", description: "Switch reply detail", policyKey: "reply" },
];

export function buildTelegramCommandList(
  allowedCommands: BotConfig["allowedCommands"],
): Array<{ command: string; description: string }> {
  const policy = allowedCommands as Record<string, boolean | undefined>;
  return TELEGRAM_COMMAND_MAP.filter(
    (entry) => !entry.policyKey || policy[entry.policyKey] !== false,
  ).map((entry) => ({ command: entry.command, description: entry.description }));
}

/**
 * syncTelegramMyCommands（§3.1 setMyCommands/deleteMyCommands）：
 * enabled=false → deleteMyCommands 清命令；enabled → setMyCommands 同步命令表。
 * telegramRuntime 启动（bot 启用时）与 provider.syncCommands 共用。
 */
export async function syncTelegramMyCommands(
  fetchImpl: typeof fetch,
  apiBase: string,
  token: string,
  bot: Pick<BotConfig, "enabled" | "allowedCommands">,
): Promise<void> {
  if (!token.trim()) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_HTTP_TIMEOUT_MS);
  try {
    if (!bot.enabled) {
      await fetchImpl(`${apiBase}/bot${token}/deleteMyCommands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
        signal: controller.signal,
      }).catch(() => undefined);
      return;
    }
    await fetchImpl(`${apiBase}/bot${token}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands: buildTelegramCommandList(bot.allowedCommands) }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export function sliceTelegramText(text: string, limit = TELEGRAM_SLICE_LIMIT): string[] {
  const slices: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const breakAt = Math.max(rest.lastIndexOf("\n", limit), rest.lastIndexOf(" ", limit));
    const cut = breakAt > 0 ? breakAt : limit;
    slices.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) slices.push(rest);
  return slices.length > 0 ? slices : [""];
}

interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

/** 仅末片带 reply_markup；每选项一行 + 末行取消 `zc:cancel`。 */
export function buildTelegramInlineKeyboard(outbound: OutboundMessage): TelegramInlineButton[][] {
  const selection = outbound.selection ?? outbound.elicitation;
  if (!selection) return [];
  const rows: TelegramInlineButton[][] = (selection as { options: Array<{ id: string; label: string }> })
    .options.map((option, index) => [
      {
        text: option.label,
        callback_data: buildSelectionCallbackData({
          action: (selection as { action: Parameters<typeof buildSelectionCallbackData>[0]["action"] }).action,
          index: index + 1,
          ...((selection as { token?: string }).token
            ? { token: (selection as { token?: string }).token }
            : {}),
        }),
      },
    ]);
  const showCancel = (selection as { showCancel?: boolean }).showCancel !== false;
  if (showCancel) {
    rows.push([{ text: (selection as { cancelLabel?: string }).cancelLabel ?? "Cancel", callback_data: "zc:cancel" }]);
  }
  return rows;
}

export interface TelegramProviderOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  /** 凭据读取（key = bot.credentialRef，即 `bot:<id>:credential`）。 */
  credentialLoader?: (key: string) => Promise<string | null>;
}

export function createTelegramBotProvider(
  options: TelegramProviderOptions = {},
): BotProviderAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase ?? TELEGRAM_API_BASE;
  const loadCredential = options.credentialLoader ?? (async () => null);
  const resolveToken = async (bot: BotConfig, credential?: string | null): Promise<string> =>
    credential ?? (bot.credentialRef ? ((await loadCredential(bot.credentialRef)) ?? "") : "");

  const call = async <T>(
    token: string,
    method: string,
    body?: unknown,
    timeoutMs = TELEGRAM_HTTP_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    try {
      const response = await fetchImpl(`${apiBase}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  };

  const sendMessage = async (
    token: string,
    chatId: string,
    text: string,
    replyMarkup?: unknown,
  ): Promise<void> => {
    try {
      await call(token, "sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    } catch {
      // Markdown 降级：去 parse_mode 重发
      await call(token, "sendMessage", {
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    }
  };

  return {
    provider: "telegram",
    /** setMyCommands/deleteMyCommands 同步（§3.1）：enabled=false → 清命令。 */
    async syncCommands(bot) {
      const token = await resolveToken(bot);
      await syncTelegramMyCommands(fetchImpl, apiBase, token, bot);
    },
    /** sendChatAction{action:"typing"}，发到 chatId ?? providerUserId。 */
    async sendTyping(bot, actor) {
      const token = await resolveToken(bot);
      const chatId = actor.chatId ?? actor.providerUserId;
      if (!token.trim() || !chatId) return;
      await call(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(
        () => undefined,
      );
    },
    async send(bot, outbound) {
      const token = await resolveToken(bot);
      const slices = sliceTelegramText(outbound.text || formatSelectionFallback(outbound.selection!, outbound.locale));
      const keyboard = buildTelegramInlineKeyboard(outbound);
      for (let index = 0; index < slices.length; index += 1) {
        const isLast = index === slices.length - 1;
        await sendMessage(
          token,
          outbound.providerUserId,
          slices[index] ?? "",
          isLast && keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
        );
      }
    },
    async test(bot, credential): Promise<BotTestResult> {
      const token = await resolveToken(bot, credential);
      const result = await call<{ ok?: boolean; result?: { first_name?: string; username?: string } }>(
        token,
        "getMe",
      );
      if (!result.ok) {
        return { ok: false, message: "getMe failed.", provider: "telegram" };
      }
      const name = result.result?.first_name || result.result?.username;
      return { ok: true, ...(name ? { name } : {}), message: "ok", provider: "telegram" };
    },
    async resolveName(bot, credential) {
      const token = await resolveToken(bot, credential);
      const result = await call<{ ok?: boolean; result?: { first_name?: string; username?: string } }>(
        token,
        "getMe",
      );
      return result.ok ? (result.result?.first_name || result.result?.username) : undefined;
    },
    async parseCallback(bot, payload, _secret) {
      const update = payload as {
        update_id?: number;
        message?: Record<string, unknown>;
        callback_query?: Record<string, unknown>;
      };
      const messages: InboundMessage[] = [];
      if (update.message && bot) {
        const parsed = parseTelegramMessage(bot.id, update.message);
        if (parsed) messages.push(parsed);
      }
      if (update.callback_query && bot) {
        const parsed = parseTelegramCallbackQuery(bot.id, update.callback_query);
        if (parsed) messages.push(parsed);
      }
      return { ok: messages.length > 0, messages };
    },
    /** answerCallbackQuery（toast 180 截断，文本空则不带 text）+ editMessageReplyMarkup 清键盘（官方 ack @635279/635513）。 */
    async acknowledgeCallback(bot, payload, text, _firstReply, signal) {
      const token = await resolveToken(bot);
      const callbackId = readTelegramCallbackId(payload);
      if (!token.trim() || !callbackId) return;
      // 应答失败向上抛（外层 Yd 捕获告警 provider callback acknowledge failed）
      await call(
        token,
        "answerCallbackQuery",
        {
          callback_query_id: callbackId,
          ...(text?.trim() ? { text: truncateCallbackToast(text) } : {}),
        },
        TELEGRAM_HTTP_TIMEOUT_MS,
        signal,
      );
      const ref = readTelegramCallbackMessageRef(payload);
      // 清键盘仅在 toast 文本非空且消息可定位时执行（官方 `u&&s?.trim()&&`）；失败静默
      if (ref && text?.trim()) {
        await call(
          token,
          "editMessageReplyMarkup",
          {
            chat_id: ref.chatId,
            message_id: ref.messageId,
            reply_markup: { inline_keyboard: [] },
          },
          TELEGRAM_HTTP_TIMEOUT_MS,
          signal,
        ).catch(() => undefined);
      }
    },
    async downloadAttachment(bot, attachment) {
      const token = await resolveToken(bot);
      const fileId = attachment.providerFileId ?? attachment.id;
      if (!fileId) return null;
      const fileInfo = await call<{ ok?: boolean; result?: { file_path?: string } }>(
        token,
        "getFile",
        { file_id: fileId },
      );
      const filePath = fileInfo.result?.file_path;
      if (!filePath) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TELEGRAM_DOWNLOAD_TIMEOUT_MS);
      try {
        const response = await fetchImpl(`${apiBase}/file/bot${token}/${filePath}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`file download failed: HTTP ${response.status}`);
        }
        const data = new Uint8Array(await response.arrayBuffer());
        return { attachment, data };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function parseTelegramActor(botId: string, source: Record<string, unknown>): BotActor {
  const chat = (source.chat ?? {}) as Record<string, unknown>;
  const from = (source.from ?? chat) as Record<string, unknown>;
  const chatId = typeof chat.id === "number" ? String(chat.id) : undefined;
  const isGroup = chat.type === "group" || chat.type === "supergroup";
  const firstName = typeof from.first_name === "string" ? from.first_name : "";
  const username = typeof from.username === "string" ? from.username : "";
  return {
    provider: "telegram",
    botId,
    providerUserId: String(from.id ?? ""),
    ...(firstName || username ? { displayName: firstName || username } : {}),
    chatType: isGroup ? "group" : "private",
    ...(chatId ? { chatId } : {}),
    ...(typeof source.message_id !== "undefined"
      ? { providerMessageId: String(source.message_id) }
      : {}),
  };
}

function parseTelegramAttachments(message: Record<string, unknown>): BotAttachment[] {
  const attachments: BotAttachment[] = [];
  const photo = message.photo;
  if (Array.isArray(photo) && photo.length > 0) {
    const file = photo.at(-1) as { file_id?: string; file_size?: number };
    if (file?.file_id) {
      attachments.push({
        kind: "image",
        id: file.file_id,
        filename: `${file.file_id}.jpg`,
        mimeType: "image/jpeg",
        ...(file.file_size !== undefined ? { sizeBytes: file.file_size } : {}),
        providerFileId: file.file_id,
      });
    }
  }
  for (const [key, kind] of [
    ["document", "file"],
    ["audio", "audio"],
    ["voice", "audio"],
    ["video", "video"],
  ] as const) {
    const file = message[key] as
      | { file_id?: string; file_name?: string; mime_type?: string; file_size?: number }
      | undefined;
    if (file?.file_id) {
      attachments.push({
        kind,
        id: file.file_id,
        filename: file.file_name ?? `${file.file_id}`,
        ...(file.mime_type ? { mimeType: file.mime_type } : {}),
        ...(file.file_size !== undefined ? { sizeBytes: file.file_size } : {}),
        providerFileId: file.file_id,
      });
    }
  }
  return attachments;
}

export function parseTelegramMessage(botId: string, message: Record<string, unknown>): InboundMessage | null {
  const text = typeof message.text === "string" ? message.text : "";
  const attachments = parseTelegramAttachments(message);
  if (!text && attachments.length === 0) return null;
  return {
    botId,
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
    actor: parseTelegramActor(botId, message),
  };
}

export function parseTelegramCallbackQuery(
  botId: string,
  query: Record<string, unknown>,
): InboundMessage | null {
  const data = typeof query.data === "string" ? query.data : "";
  if (!data) return null;
  const text = decodeTelegramCallbackData(data);
  const message = (query.message ?? {}) as Record<string, unknown>;
  const from = (query.from ?? {}) as Record<string, unknown>;
  const chat = (message.chat ?? {}) as Record<string, unknown>;
  const chatId = typeof chat.id === "number" ? String(chat.id) : undefined;
  const actor: BotActor = {
    provider: "telegram",
    botId,
    providerUserId: String(from.id ?? ""),
    ...(typeof from.username === "string" ? { displayName: from.username } : {}),
    chatType: chat.type === "group" || chat.type === "supergroup" ? "group" : "private",
    ...(chatId ? { chatId } : {}),
    ...(typeof query.id !== "undefined" ? { providerMessageId: String(query.id) } : {}),
  };
  return { botId, text, actor };
}
