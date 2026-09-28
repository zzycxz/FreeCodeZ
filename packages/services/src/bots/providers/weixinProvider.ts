// 微信 iLink 渠道（附录B §3.2）：getupdates 90s / sendmessage / getconfig / sendtyping；
// 扫码注册 get_bot_qrcode?bot_type=3（头 iLink-App-Client-Version: 1，3s 轮询/120s）；
// 头 AuthorizationType: ilink_bot_token + 随机 X-WECHAT-UIN + base_info.channel_version 2.0.0；
// CDN 媒体 AES-128-ECB 解密；消息解析多键容错；message_type===2 丢弃。
/* eslint-disable max-lines -- iLink 客户端（4 API + 扫码注册 + 多键容错解析 + AES 解密）为渠道单一职责单元。 */
import { createDecipheriv, randomInt } from "node:crypto";
import { randomUUID } from "node:crypto";
import type {
  BotActor,
  BotAttachment,
  BotConfig,
  InboundMessage,
} from "@zcode/shared/bots";
import type { BotProviderAdapter, BotTestResult } from "../bots.js";

export const WEIXIN_API_BASE = "https://ilinkai.weixin.qq.com";
export const WEIXIN_CHANNEL_VERSION = "2.0.0";
const WEIXIN_REQUEST_TIMEOUT_MS = 30_000;
const WEIXIN_QR_TTL_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** buildWeixinText：微信纯文本换行 \r\n。 */
export function buildWeixinText(text: string): string {
  return text.replace(/\r\n|\n|\r/gu, "\r\n");
}

/** parseWeixinAesKey：32hex→Buffer / base64→16B / base64→utf8 32hex。 */
export function parseWeixinAesKey(aesKey: string): Buffer {
  const trimmed = aesKey.trim();
  if (/^[0-9a-fA-F]{32}$/u.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.byteLength === 16) return decoded;
  const asText = decoded.toString("utf8");
  if (/^[0-9a-fA-F]{32}$/u.test(asText)) {
    return Buffer.from(asText, "hex");
  }
  return decoded.subarray(0, 16);
}

/** AES-128-ECB 媒体解密。 */
export function decryptWeixinMedia(cipher: Uint8Array, aesKey: string): Uint8Array {
  const key = parseWeixinAesKey(aesKey);
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(cipher)), decipher.final()]));
}

export interface WeixinProviderOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  credentialLoader?: (key: string) => Promise<string | null>;
  now?: () => number;
}

interface WeixinApiResult {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  message?: string;
  [key: string]: unknown;
}

export function createWeixinBotProvider(options: WeixinProviderOptions = {}): BotProviderAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase ?? WEIXIN_API_BASE;
  const loadCredential = options.credentialLoader ?? (async () => null);

  const resolveToken = async (bot: BotConfig, credential?: string | null): Promise<string> =>
    credential ?? (bot.credentialRef ? ((await loadCredential(bot.credentialRef)) ?? "") : "");

  const callIlilink = async <T extends WeixinApiResult>(
    token: string,
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${apiBase}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${token}`,
          "X-WECHAT-UIN": Buffer.from(String(randomInt(0, 2 ** 32))).toString("base64"),
        },
        body: JSON.stringify({ base_info: { channel_version: WEIXIN_CHANNEL_VERSION }, ...body }),
        signal: controller.signal,
      });
      const result = (await response.json()) as T;
      if ((result.ret !== undefined && result.ret !== 0) || (result.errcode !== undefined && result.errcode !== 0)) {
        throw new Error(result.errmsg ?? result.message ?? "weixin api failed");
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    provider: "weixin",
    async send(bot, outbound) {
      const token = await resolveToken(bot);
      await callIlilink(
        token,
        "/ilink/bot/sendmessage",
        {
          msg: {
            from_user_id: bot.providerUserId ?? "",
            to_user_id: outbound.providerUserId,
            client_id: `zcode-weixin-${randomUUID()}`,
            message_type: 2,
            message_state: 2,
            ...(outbound.providerContextToken ? { context_token: outbound.providerContextToken } : {}),
            item_list: [{ type: 1, text_item: { text: buildWeixinText(outbound.text) } }],
          },
        },
        WEIXIN_REQUEST_TIMEOUT_MS,
      );
    },
    async test(bot, credential): Promise<BotTestResult> {
      const token = await resolveToken(bot, credential);
      const result = await callIlilink(
        token,
        "/ilink/bot/getconfig",
        { ilink_user_id: bot.providerUserId ?? "" },
        WEIXIN_REQUEST_TIMEOUT_MS,
      );
      void result;
      return { ok: true, message: "ok", provider: "weixin" };
    },
    async sendTyping(bot, _actor) {
      const token = await resolveToken(bot);
      const config = await callIlilink<{ typing_ticket?: string; [key: string]: unknown }>(
        token,
        "/ilink/bot/getconfig",
        { ilink_user_id: bot.providerUserId ?? "" },
        WEIXIN_REQUEST_TIMEOUT_MS,
      );
      const ticket = typeof config.typing_ticket === "string" ? config.typing_ticket : "";
      if (!ticket) return;
      await callIlilink(
        token,
        "/ilink/bot/sendtyping",
        { ilink_user_id: bot.providerUserId ?? "", typing_ticket: ticket, status: 1 },
        WEIXIN_REQUEST_TIMEOUT_MS,
      );
    },
    async parseCallback(bot, payload, _secret) {
      if (!bot) return { ok: false, messages: [], status: 400 };
      const messages = parseWeixinUpdates(bot.id, payload);
      return { ok: messages.length > 0, messages };
    },
    async downloadAttachment(bot, attachment) {
      if (!attachment.downloadUrl) return null;
      const token = await resolveToken(bot);
      void token;
      const response = await fetchImpl(attachment.downloadUrl, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`file download failed: HTTP ${response.status}`);
      const raw = new Uint8Array(await response.arrayBuffer());
      const aesKey = (attachment as WeixinBotAttachment).aesKey;
      const data = aesKey ? decryptWeixinMedia(raw, aesKey) : raw;
      return { attachment, data };
    },
  };
}

/** getupdates 游标 6 种 fallback 字段名。 */
export function extractWeixinUpdatesCursor(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  for (const key of [
    "get_updates_buf",
    "getUpdatesBuf",
    "updates_buf",
    "cursor",
    "next_cursor",
    "sync_key",
  ]) {
    const value = result[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

const USER_ID_KEYS = [
  "ilink_user_id",
  "from_user_id",
  "user_id",
  "userid",
  "open_id",
  "fromuserid",
  "sender_id",
  "external_user_id",
  "wxid",
];
const CHAT_ID_KEYS = ["chat_id", "chatid", "to_user_id", "session_id", "room_id", "conversation_id"];
const MSG_ID_KEYS = ["msg_id", "message_id", "msgid", "id"];

function readFirstString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function heuristicAttachmentKind(filename: string, mime?: string): BotAttachment["kind"] {
  const lowered = filename.toLowerCase();
  if (mime?.startsWith("audio/") || /voice|audio/.test(lowered)) return "audio";
  if (mime?.startsWith("video/") || /\.(mp4|mov|avi|mkv)$/u.test(lowered)) return "video";
  if (mime?.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/u.test(lowered)) return "image";
  return "file";
}

/** 微信附件携带 AES key（schema 外传输字段，仅下载解密用）。 */
export type WeixinBotAttachment = BotAttachment & { aesKey?: string };

function parseWeixinAttachments(raw: Record<string, unknown>): WeixinBotAttachment[] {
  const items = Array.isArray(raw.item_list)
    ? raw.item_list
    : Array.isArray(raw.attachments)
      ? raw.attachments
      : [];
  const attachments: WeixinBotAttachment[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const file = (isRecord(item.file_item) ? item.file_item : item) as Record<string, unknown>;
    const filename =
      readFirstString(file, ["file_name", "filename", "name", "title"]) ??
      readFirstString(item, ["file_name", "filename", "name"]) ??
      "attachment";
    const mimeType = readFirstString(file, ["mime_type", "content_type", "type"]);
    const providerFileId = readFirstString(file, ["file_id", "fileid", "id"]);
    const downloadUrl = readFirstString(file, ["url", "download_url", "file_url", "cdn_url"]);
    const dataBase64 = readFirstString(file, ["data_base64", "base64", "content_base64"]);
    const aesKey = readFirstString(file, ["aes_key", "aeskey"]);
    attachments.push({
      kind: heuristicAttachmentKind(filename, mimeType),
      ...(providerFileId ? { id: providerFileId, providerFileId } : {}),
      filename,
      ...(mimeType ? { mimeType } : {}),
      ...(downloadUrl ? { downloadUrl } : {}),
      ...(dataBase64 ? { dataBase64 } : {}),
      ...(aesKey ? { aesKey } : {}),
    });
  }
  return attachments;
}

/** getupdates 载荷 → InboundMessage 列表（容错多键；message_type===2 丢弃）。 */
export function parseWeixinUpdates(botId: string, payload: unknown): InboundMessage[] {
  const root = isRecord(payload) ? payload : {};
  const rawMessages: unknown[] = Array.isArray(root.messages)
    ? root.messages
    : Array.isArray(root.msg_list)
      ? root.msg_list
      : Array.isArray(root.list)
        ? root.list
        : Array.isArray(root.updates)
          ? root.updates
          : isRecord(root.msg)
            ? [root.msg]
            : isRecord(root.message)
              ? [root.message]
              : [];
  const messages: InboundMessage[] = [];
  for (const entry of rawMessages) {
    if (!isRecord(entry)) continue;
    const message = (isRecord(entry.msg) ? entry.msg : entry) as Record<string, unknown>;
    if (message.message_type === 2) continue;
    const userId = readFirstString(message, USER_ID_KEYS) ?? readFirstString(entry, USER_ID_KEYS);
    if (!userId) continue;
    const text = (() => {
      const item = Array.isArray(message.item_list) ? message.item_list[0] : undefined;
      if (isRecord(item) && isRecord(item.text_item) && typeof item.text_item.text === "string") {
        return item.text_item.text;
      }
      return readFirstString(message, ["text", "content", "body"]) ?? "";
    })();
    const attachments = parseWeixinAttachments(message);
    if (!text && attachments.length === 0) continue;
    const chatId = readFirstString(message, CHAT_ID_KEYS) ?? readFirstString(entry, CHAT_ID_KEYS);
    const providerMessageId = readFirstString(message, MSG_ID_KEYS) ?? readFirstString(entry, MSG_ID_KEYS);
    const displayName = readFirstString(message, ["display_name", "nickname", "name"]);
    const contextToken = readFirstString(message, ["context_token", "contextToken"]);
    const actor: BotActor = {
      provider: "weixin",
      botId,
      providerUserId: userId,
      ...(displayName ? { displayName } : {}),
      chatType: chatId && chatId !== userId ? "group" : "private",
      ...(chatId ? { chatId } : {}),
      ...(providerMessageId ? { providerMessageId } : {}),
      ...(contextToken ? { providerContextToken: contextToken } : {}),
    };
    messages.push({
      botId,
      text,
      ...(attachments.length > 0 ? { attachments: attachments as BotAttachment[] } : {}),
      actor,
    });
  }
  return messages;
}

// ── 扫码注册（get_bot_qrcode?bot_type=3） ──

export interface WeixinQrBegin {
  qrCode: string;
  qrUrl: string;
  expiresAt: number;
}

/** 扫码注册 GET；头 iLink-App-Client-Version: 1；expires_in 默认 120s。 */
export async function beginWeixinQrRegistration(
  fetchImpl: typeof fetch,
  apiBase = WEIXIN_API_BASE,
  now: () => number = Date.now,
): Promise<WeixinQrBegin> {
  const response = await fetchImpl(`${apiBase}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    headers: { "iLink-App-Client-Version": "1" },
    signal: AbortSignal.timeout(WEIXIN_REQUEST_TIMEOUT_MS),
  });
  const result = (await response.json()) as Record<string, unknown>;
  const qrCode = readFirstString(result, ["qrcode", "qr_code"]) ?? "";
  const qrUrl = readFirstString(result, ["qrcode_img_content", "qrcode_url"]) ?? "";
  const expiresIn =
    typeof result.expires_in === "number" ? result.expires_in * 1000 : WEIXIN_QR_TTL_MS;
  return { qrCode, qrUrl, expiresAt: now() + (expiresIn || WEIXIN_QR_TTL_MS) };
}

export type WeixinQrStatus =
  | { status: "pending" }
  | { status: "scanned" }
  | { status: "success"; botToken: string; botId?: string }
  | { status: "expired" }
  | { status: "error"; message: string };

/** status 归一：数字 0..4 + 字符串族 → pending/scanned/success/expired/error。 */
export function normalizeWeixinQrStatus(result: unknown): WeixinQrStatus {
  const root = isRecord(result) ? result : {};
  const raw = root.status ?? root.state;
  const lowered = typeof raw === "string" ? raw.toLowerCase() : String(raw ?? "");
  if (lowered === "0" || lowered === "pending" || lowered === "waiting" || lowered === "scan_pending") {
    return { status: "pending" };
  }
  if (lowered === "1" || lowered === "scanned" || lowered === "scaned" || lowered === "confirmed_pending") {
    return { status: "scanned" };
  }
  if (lowered === "2" || lowered === "success" || lowered === "ok" || lowerdIsSuccess(lowered)) {
    const botToken = readFirstString(root, ["bot_token", "token"]) ?? "";
    const botId = readFirstString(root, ["ilink_bot_id", "bot_id", "botId"]);
    return { status: "success", botToken, ...(botId ? { botId } : {}) };
  }
  if (lowered === "3" || lowered === "expired" || lowered === "timeout") {
    return { status: "expired" };
  }
  if (lowered === "4" || lowered === "error" || lowered === "failed") {
    return { status: "error", message: readFirstString(root, ["errmsg", "message"]) ?? "error" };
  }
  return { status: "error", message: `unknown status: ${lowered}` };
}

function lowerdIsSuccess(lowered: string): boolean {
  return lowered === "authorized" || lowered === "login_success" || lowered === "done";
}

export async function pollWeixinQrStatus(
  fetchImpl: typeof fetch,
  qrCode: string,
  apiBase = WEIXIN_API_BASE,
): Promise<WeixinQrStatus> {
  const response = await fetchImpl(
    `${apiBase}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrCode)}`,
    {
      headers: { "iLink-App-Client-Version": "1" },
      signal: AbortSignal.timeout(WEIXIN_REQUEST_TIMEOUT_MS),
    },
  );
  return normalizeWeixinQrStatus(await response.json());
}
