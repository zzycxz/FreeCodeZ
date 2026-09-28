// Webhook 渠道（附录B §3.4/§2.4；源码锚 host@639400-642400 G$ / host@762400-763700 Yd）：
// 出站 POST `zcode.bot.message|elicitation_request|test`，3 重试 [0,500,1500]ms（2xx/4xx 立即返回），
// 出站头 `x-zcode-bot-secret`（或 bot.webhookAuthHeaderName 覆盖，凭据非空才带）；
// 入站经 RPC handleProviderCallbackResponse 注入（无内置 HTTP 服务器）；
// 入站鉴权 = body 字段 `webhookSecret` 与凭据比对（凭据空跳过；失配丢弃该条回 webhookSecretInvalid，
// 整体 status 200）。header 不作鉴权依据（官方全构建无代码读入站 header）。
import type {
  BotActor,
  BotConfig,
  InboundMessage,
  OutboundMessage,
} from "@zcode/shared/bots";
import type { BotCallbackResponse, BotProviderAdapter, BotTestResult } from "../bots.js";
import { formatSelectionFallback } from "../replyPipeline.js";
import type { BotHostLocale } from "../hostMessages.js";

export const WEBHOOK_SECRET_HEADER_NAME = "x-zcode-bot-secret";
const WEBHOOK_RETRY_DELAYS_MS = [0, 500, 1500] as const;

interface WebhookEnvelope {
  headers?: Record<string, string | undefined>;
  body?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 入站载荷归一：支持 `{headers, body}` 信封与裸 body 两种形态。 */
export function unwrapWebhookPayload(
  payload: unknown,
): { headers: Record<string, string | undefined>; body: Record<string, unknown> | null } {
  if (isRecord(payload) && ("headers" in payload || "body" in payload)) {
    const envelope = payload as WebhookEnvelope;
    return {
      headers: (isRecord(envelope.headers) ? envelope.headers : {}) as Record<
        string,
        string | undefined
      >,
      body: isRecord(envelope.body) ? envelope.body : null,
    };
  }
  return { headers: {}, body: isRecord(payload) ? payload : null };
}

/**
 * 入站凭据字段（官方 Yd：`Je=qr(V)&&typeof V.webhookSecret=="string"?V.webhookSecret:void 0`）。
 * 只认 body 顶层 `webhookSecret`；header 方案已撤下（官方出站才写 `x-zcode-bot-secret`）。
 */
export function readWebhookSecretField(payload: unknown): string | undefined {
  const { body } = unwrapWebhookPayload(payload);
  const value = body?.webhookSecret;
  return typeof value === "string" ? value : undefined;
}

/**
 * webhook bot 入站校验（官方 Yd：`if(We&&We!==Je){丢弃该条并回 webhookSecretInvalid;continue}`）：
 * 凭据空跳过校验；凭据非空时 body `webhookSecret` 不等（含缺失）即失配。无签名/HMAC/时间戳。
 */
export function verifyWebhookSecret(
  expectedSecret: string | null,
  payload: unknown,
): { ok: boolean; reason?: "no-secret-configured" | "mismatch" } {
  if (!expectedSecret) return { ok: true, reason: "no-secret-configured" };
  return readWebhookSecretField(payload) === expectedSecret
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}

/**
 * 飞书族入站凭据（官方 Yd：`gn=qr(V)&&typeof V.token=="string"?V.token:typeof At?.token=="string"?At.token:void 0`）。
 * 比对 `payload.token | payload.header.token`（Verification Token）。
 */
export function readFeishuVerificationToken(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.token === "string") return payload.token;
  const header = isRecord(payload.header) ? payload.header : null;
  return typeof header?.token === "string" ? header.token : undefined;
}

/** buildSelectionText：正文 + `N. label - desc` + 选项命令 + 取消/hint。 */
export function buildWebhookSelectionText(
  outbound: OutboundMessage,
  locale?: BotHostLocale,
): string {
  if (!outbound.selection) return outbound.text;
  const lines = [outbound.selection.title];
  outbound.selection.options.forEach((option, index) => {
    lines.push(
      `${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`,
    );
    lines.push(option.id);
  });
  if (outbound.selection.showCancel !== false) {
    lines.push(`0. ${outbound.selection.cancelLabel ?? formatSelectionFallback(outbound.selection, locale).split("\n")[1]?.replace(/^0\.\s*/u, "") ?? "取消"}`);
  }
  return lines.join("\n");
}

export interface WebhookProviderOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** 出站鉴权头取密（key = bot.webhookSecretRef）；官方 send/test 均从凭据服务现读。 */
  credentialLoader?: (key: string) => Promise<string | null>;
}

/** postWebhookWithRetry：[0,500,1500]ms；2xx/4xx 立即返回（4xx 不重试）；5xx/网络错重试。 */
export async function postWebhookWithRetry(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  delays: readonly number[] = WEBHOOK_RETRY_DELAYS_MS,
): Promise<{ ok: boolean; status: number }> {
  let lastStatus = 0;
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const response = await fetchImpl(url, init);
      lastStatus = response.status;
      if (response.ok) return { ok: true, status: response.status };
      if (response.status < 500) return { ok: false, status: response.status };
    } catch {
      lastStatus = 0;
    }
  }
  return { ok: false, status: lastStatus };
}

export function parseWebhookInbound(
  payload: unknown,
): { ok: boolean; messages: InboundMessage[]; status?: number } {
  const { body } = unwrapWebhookPayload(payload);
  if (!body) return { ok: false, messages: [], status: 400 };
  const botId = typeof body.botId === "string" ? body.botId : "";
  const text = typeof body.text === "string" ? body.text : "";
  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!botId || !userId) return { ok: false, messages: [], status: 400 };
  const providerMessageId =
    typeof body.messageId === "string"
      ? body.messageId
      : typeof body.id === "string"
        ? body.id
        : undefined;
  const actor: BotActor = {
    provider: "webhook",
    botId,
    providerUserId: userId,
    ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
    chatType: body.chatType === "group" ? "group" : "private",
    ...(typeof body.chatId === "string" ? { chatId: body.chatId } : {}),
    ...(providerMessageId ? { providerMessageId } : {}),
  };
  const message: InboundMessage = {
    botId,
    text,
    ...(Array.isArray(body.attachments) ? { attachments: body.attachments as InboundMessage["attachments"] } : {}),
    ...(body.elicitationResponse !== undefined ? { elicitationResponse: body.elicitationResponse } : {}),
    actor,
  };
  return { ok: true, messages: [message] };
}

export function createWebhookBotProvider(options: WebhookProviderOptions = {}): BotProviderAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const loadCredential = options.credentialLoader ?? (async () => null);
  /** 出站鉴权头（官方 send：`r&&(o[t.webhookAuthHeaderName||"x-zcode-bot-secret"]=r)`）。 */
  const buildOutboundHeaders = async (
    bot: BotConfig,
    credential: string | null,
    always = false,
  ): Promise<Record<string, string>> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const secret =
      credential ?? (bot.webhookSecretRef ? ((await loadCredential(bot.webhookSecretRef)) ?? null) : null);
    if (secret || always) {
      headers[bot.webhookAuthHeaderName?.trim() || WEBHOOK_SECRET_HEADER_NAME] = secret ?? "";
    }
    return headers;
  };
  return {
    provider: "webhook",
    async send(bot: BotConfig, outbound: OutboundMessage): Promise<void> {
      if (!bot.webhookUrl) return;
      const type = outbound.elicitation
        ? "zcode.bot.elicitation_request"
        : "zcode.bot.message";
      const payload = {
        type,
        botId: outbound.botId,
        provider: "webhook",
        userId: outbound.providerUserId,
        text: buildWebhookSelectionText(outbound, outbound.locale),
        ...(outbound.selection ? { selection: outbound.selection } : {}),
        ...(outbound.elicitation ? { elicitation: outbound.elicitation } : {}),
        sentAt: (options.now ?? Date.now)(),
      };
      const result = await postWebhookWithRetry(
        bot.webhookUrl,
        {
          method: "POST",
          headers: await buildOutboundHeaders(bot, null),
          body: JSON.stringify(payload),
        },
        fetchImpl,
      );
      if (!result.ok) throw new Error(`Webhook outbound endpoint returned HTTP ${result.status}`);
    },
    async test(bot: BotConfig, credential: string | null): Promise<BotTestResult> {
      if (!bot.webhookUrl) {
        return { ok: false, message: "Webhook URL is required.", provider: "webhook" };
      }
      const payload = {
        type: "zcode.bot.test",
        botId: bot.id,
        provider: "webhook",
        sentAt: (options.now ?? Date.now)(),
      };
      const result = await postWebhookWithRetry(
        bot.webhookUrl,
        {
          method: "POST",
          // 官方 test 恒带鉴权头（无密为空串）：`[t.webhookAuthHeaderName||"x-zcode-bot-secret"]:n??""`
          headers: await buildOutboundHeaders(bot, credential, true),
          body: JSON.stringify(payload),
        },
        fetchImpl,
      );
      return result.ok
        ? { ok: true, message: "ok", provider: "webhook" }
        : { ok: false, message: `HTTP ${result.status}`, provider: "webhook" };
    },
    async parseCallback(_bot, payload) {
      // 官方 parseCallback 纯解析（无 secret 参数）；鉴权在 processProviderCallback 逐条比对
      const parsed = parseWebhookInbound(payload);
      return {
        ok: parsed.ok,
        messages: parsed.messages,
        ...(parsed.status ? { status: parsed.status } : {}),
        body: { ok: parsed.ok },
      };
    },
    async acknowledgeCallback(_bot, _payload, _text, _firstReply) {
      // webhook 无同步回执语义；由 handleProviderCallbackResponse 返回 responseBody 承载
      return { handled: false };
    },
  };
}

/** handleProviderCallbackResponse 的 webhook 响应体构造（含 elicitation 结构化应答回执）。 */
export function buildWebhookCallbackResponseBody(
  result: BotCallbackResponse,
): Record<string, unknown> {
  return {
    ok: result.ok,
    replies: result.replies.map((reply) => ({
      text: reply.text,
      ...(reply.selection ? { selection: reply.selection } : {}),
      ...(reply.elicitation ? { elicitation: reply.elicitation } : {}),
    })),
  };
}
