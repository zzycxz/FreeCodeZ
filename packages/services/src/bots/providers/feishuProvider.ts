// 飞书/Lark 渠道（附录B §3.3/§2.4）：tenant_access_token 90min 缓存（剩 <60s 才刷新）、
// Card JSON 2.0 流式卡（>180 tagged 元素拆卡、1900 切片）、elicitation 表单卡（form submit __form__:）、
// accounts device-code 注册（init/begin/poll，pollDomain 切 lark）。WS 生命周期在 runtimes/feishuRuntime。
/* eslint-disable max-lines -- Card 2.0 构造（选择/表单/流式卡拆卡）+ token 缓存 + accounts 注册协议同属飞书渠道适配面。 */
import type {
  BotActor,
  BotAttachment,
  BotConfig,
  BotSelection,
  BotDeliveryTarget,
  ElicitationView,
  InboundMessage,
  OutboundMessage,
} from "@zcode/shared/bots";
import type {
  BotProviderAdapter,
  BotTestResult,
  FeishuRegistrationBegin,
  FeishuRegistrationPoll,
} from "../bots.js";
import {
  ELICITATION_CUSTOM_OPTION,
  ELICITATION_FORM_PREFIX,
  ELICITATION_SUBMIT_OPTION,
  getPendingElicitationSelectionToken,
} from "../elicitation.js";
import { formatBotMessage, formatStreamingMessage, type BotHostLocale } from "../hostMessages.js";
import { splitLongReplyText } from "../replyPipeline.js";

export const FEISHU_DOMAIN = "https://open.feishu.cn";
export const LARK_DOMAIN = "https://open.larksuite.com";
export const FEISHU_ACCOUNTS_DOMAIN = "https://accounts.feishu.cn";
export const LARK_ACCOUNTS_DOMAIN = "https://accounts.larksuite.com";
export const FEISHU_CARD_TEXT_SLICE = 1900;
export const FEISHU_CARD_MAX_TAGGED_ELEMENTS = 180;
const TOKEN_TTL_MS = 90 * 60_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export interface FeishuStreamingCardBlock {
  type: "message" | "tools";
  text?: string;
  title?: string;
  summaries?: string[];
  expanded?: boolean;
}

export interface FeishuStreamingCardState {
  providerUserId: string;
  locale: BotHostLocale;
  blocks: FeishuStreamingCardBlock[];
  status: "running" | "completed" | "error" | "sealed";
}

interface FeishuTokenCache {
  token: string;
  expiresAt: number;
}

/** typing reaction 登记（官方 py 表，模块级）：`<botId>:<messageId>` → reaction_id。 */
const typingReactionIds = new Map<string, string>();

/** getFeishuTypingReactionKey（bZ）：`${bot.id}:${messageId}`。 */
export function getFeishuTypingReactionKey(bot: Pick<BotConfig, "id">, messageId: string): string {
  return `${bot.id}:${messageId}`;
}

export interface FeishuProviderOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  credentialLoader?: (key: string) => Promise<string | null>;
  now?: () => number;
}

export function resolveFeishuDomain(provider: "feishu" | "lark" | string): string {
  return provider === "lark" ? LARK_DOMAIN : FEISHU_DOMAIN;
}

export function resolveFeishuAccountsDomain(provider: "feishu" | "lark" | string): string {
  return provider === "lark" ? LARK_ACCOUNTS_DOMAIN : FEISHU_ACCOUNTS_DOMAIN;
}

/** Card JSON 2.0 外壳。 */
export function buildFeishuCardShell(elements: unknown[]): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: { elements },
  };
}

function markdownElement(text: string): Record<string, unknown> {
  return { tag: "markdown", content: text };
}

/** 代码块保护 / `---` 补空行 / 行尾两空格硬换行。 */
export function normalizeFeishuMarkdown(text: string): string {
  return text
    .replace(/\n---\n/gu, "\n\n---\n\n")
    .split("\n")
    .map((line) => (line.trim() ? `${line}  ` : line))
    .join("\n");
}

export function buildFeishuSelectionCard(
  outbound: OutboundMessage,
  locale: BotHostLocale,
): Record<string, unknown> {
  const selection = outbound.selection;
  if (!selection) return buildFeishuCardShell([markdownElement(normalizeFeishuMarkdown(outbound.text))]);
  const elements: unknown[] = [markdownElement(normalizeFeishuMarkdown(outbound.text || selection.title))];
  for (const option of selection.options) {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: option.label },
      type: "primary",
      behaviors: [
        {
          type: "callback",
          value: { command: option.id, zcodeCardText: outbound.text },
        },
      ],
    });
  }
  if (selection.showCancel !== false) {
    elements.push({
      tag: "button",
      text: {
        tag: "plain_text",
        content: selection.cancelLabel ?? formatBotMessage(locale, "selectionCancelOption"),
      },
      type: "default",
      behaviors: [{ type: "callback", value: { command: "/cancel", zcodeCardText: outbound.text } }],
    });
  }
  return buildFeishuCardShell(elements);
}

/** elicitation 卡（buildFeishuElicitationCardPayload）：已答题/当前题/选项/自定义/form submit __form__。 */
export function buildFeishuElicitationCard(
  elicitation: ElicitationView,
  locale: BotHostLocale,
): Record<string, unknown> {
  const elements: unknown[] = [];
  for (let index = 0; index < elicitation.currentQuestionIndex; index += 1) {
    const question = elicitation.questions[index];
    const answers = (elicitation.answers[String(index)] ?? []).join(", ");
    elements.push(markdownElement(`#### ${index + 1}/${elicitation.questions.length} ${question?.header ?? ""}\n${answers}`));
    elements.push({ tag: "hr" });
  }
  const current = elicitation.questions[elicitation.currentQuestionIndex];
  const currentAnswers = new Set(elicitation.answers[String(elicitation.currentQuestionIndex)] ?? []);
  const token = getPendingElicitationSelectionToken({
    taskId: elicitation.taskId,
    runId: elicitation.runId,
    requestId: elicitation.requestId,
    currentQuestionIndex: elicitation.currentQuestionIndex,
  });
  if (elicitation.schema?.interaction === "plan_approval") {
    // 计划审批卡（§2.3）：plan markdown + `---` + 标题 + 批准按钮
    elements.push(
      markdownElement(`${elicitation.schema.plan}\n\n---\n\n${formatBotMessage(locale, "planApprovalTitle")}`),
    );
  } else if (current) {
    elements.push(markdownElement(current.question));
  }
  if (current) {
    for (const option of current.options) {
      const marker = current.multiSelect
        ? currentAnswers.has(option.value)
          ? "☑"
          : "☐"
        : currentAnswers.has(option.value)
          ? "●"
          : "○";
      elements.push({
        tag: "button",
        text: { tag: "plain_text", content: `${marker} ${option.label}` },
        type: "default",
        behaviors: [
          {
            type: "callback",
            value: { command: `/elicitation ${token} ${option.value}`, zcodeCardText: option.value },
          },
        ],
      });
    }
  }
  elements.push({
    tag: "button",
    text: { tag: "plain_text", content: formatBotMessage(locale, "elicitationCustomOption") },
    type: "default",
    behaviors: [
      {
        type: "callback",
        value: { command: `/elicitation ${token} ${ELICITATION_CUSTOM_OPTION}`, zcodeCardText: "" },
      },
    ],
  });
  elements.push({
    tag: "form",
    name: "elicitation_form",
    elements: [
      {
        tag: "input",
        name: "answer",
        required: false,
        placeholder: { tag: "plain_text", content: formatBotMessage(locale, "elicitationCustomPlaceholder") },
        default_value: (elicitation.answers[String(elicitation.currentQuestionIndex)] ?? []).join(", "),
        label: { tag: "plain_text", content: formatBotMessage(locale, "elicitationQuestionTitle") },
        rows: 2,
        max_rows: 5,
        auto_resize: true,
        tag_type: "multiline_text",
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: formatBotMessage(locale, "elicitationSubmitOption") },
        type: "primary",
        form_action_type: "submit",
        name: "submit",
        behaviors: [
          {
            type: "callback",
            value: {
              command: `/elicitation ${token} ${ELICITATION_FORM_PREFIX}`,
              zcodeCardText: ELICITATION_SUBMIT_OPTION,
            },
          },
        ],
      },
    ],
  });
  return buildFeishuCardShell(elements);
}

/** 流式卡（buildFeishuStreamingCardPayload）：message/tools 块 + 非 sealed 尾注 `_⏳ 运行中_`。 */
export function buildFeishuStreamingCard(
  state: FeishuStreamingCardState,
): Record<string, unknown> {
  const elements: unknown[] = [];
  for (const block of state.blocks) {
    if (block.type === "message") {
      if (block.text?.trim()) elements.push(markdownElement(normalizeFeishuMarkdown(block.text)));
      continue;
    }
    const rows = (block.summaries ?? []).join("\n");
    elements.push({
      tag: "collapsible_panel",
      expanded: block.expanded ?? false,
      header: {
        title: {
          tag: "plain_text",
          content: block.title ?? formatStreamingMessage(state.locale, "toolCalls"),
        },
        icon: { tag: "standard_icon", token: "tool_outlined", size: "16px 16px" },
        icon_position: "follow_text",
        icon_angle: 0,
        vertical_align: "center",
        padding: "4px 8px",
        background_style: "grey-50",
        corner_radius: 8,
      },
      border: { color: "grey-50" },
      elements: [markdownElement(rows)],
    });
  }
  if (elements.length === 0) {
    elements.push(markdownElement(formatBotMessage(state.locale, "streamingWorking")));
  }
  if (state.status !== "sealed") {
    elements.push({
      tag: "markdown",
      content: `_${formatBotMessage(state.locale, "streamingStatusRunning")}_`,
    });
  }
  return buildFeishuCardShell(elements);
}

export interface FeishuSplitState {
  cards: FeishuStreamingCardState[];
}

/** splitFeishuStreamingCardStates：>180 tagged 元素拆卡，前卡 sealed；文本 1900 切片。 */
export function splitFeishuStreamingCardStates(state: FeishuStreamingCardState): FeishuStreamingCardState[] {
  const cards: FeishuStreamingCardState[] = [];
  let currentBlocks: FeishuStreamingCardBlock[] = [];
  let taggedCount = 0;
  const pushCard = (sealed: boolean): void => {
    cards.push({ ...state, blocks: currentBlocks, status: sealed ? "sealed" : state.status });
    currentBlocks = [];
    taggedCount = 0;
  };
  for (const block of state.blocks) {
    const blockCount =
      block.type === "message"
        ? Math.max(1, splitLongReplyText(block.text ?? "", FEISHU_CARD_TEXT_SLICE).length)
        : 1 + (block.summaries?.length ?? 0);
    if (taggedCount > 0 && taggedCount + blockCount > FEISHU_CARD_MAX_TAGGED_ELEMENTS) {
      pushCard(true);
    }
    if (block.type === "message") {
      for (const slice of splitLongReplyText(block.text ?? "", FEISHU_CARD_TEXT_SLICE)) {
        currentBlocks.push({ type: "message", text: slice });
        taggedCount += 1;
      }
    } else {
      currentBlocks.push(block);
      taggedCount += blockCount;
    }
  }
  pushCard(false);
  return cards.length > 0 ? cards : [{ ...state, blocks: [], status: state.status }];
}

export function createFeishuOutboundCard(
  outbound: OutboundMessage,
  locale: BotHostLocale,
): Record<string, unknown> {
  if (outbound.elicitation) {
    return outbound.elicitation.status === "cancelled"
      ? buildFeishuCardShell([markdownElement(formatBotMessage(locale, "elicitationCancelledCard"))])
      : buildFeishuElicitationCard(outbound.elicitation, locale);
  }
  return buildFeishuSelectionCard(outbound, locale);
}

// ── card.action.trigger 回执字段提取（yde/wde/vde 多键容错） ──

function readStringField(source: unknown, keys: readonly string[]): string {
  if (!isRecord(source)) return "";
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/** readFeishuCardUpdateToken（yde）：token/card_update_token/update_token 多级查找。 */
export function readFeishuCardUpdateToken(payload: unknown): string {
  if (!isRecord(payload)) return "";
  const event = isRecord(payload.event) ? payload.event : payload;
  const action = isRecord(event.action) ? event.action : null;
  const context = isRecord(event.context) ? event.context : null;
  const keys = ["token", "card_update_token", "update_token"];
  return (
    readStringField(event, keys) ||
    readStringField(payload, keys) ||
    readStringField(action, keys) ||
    readStringField(context, keys)
  );
}

/** readFeishuCardUpdateOpenIds（wde）：operator.operator_id.open_id → open_id。 */
export function readFeishuCardUpdateOpenIds(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const event = isRecord(payload.event) ? payload.event : payload;
  const operator = isRecord(event.operator) ? event.operator : null;
  const operatorId = isRecord(operator?.operator_id) ? operator.operator_id : null;
  const openId =
    readStringField(operatorId, ["open_id"]) ||
    readStringField(operator, ["open_id"]) ||
    readStringField(event, ["open_id"]) ||
    readStringField(payload, ["open_id"]);
  return openId ? [openId] : [];
}

/** readFeishuCardOriginalText（vde）：action.value/behaviors 的 zcodeCardText。 */
export function readFeishuCardOriginalText(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const event = isRecord(payload.event) ? payload.event : payload;
  const action = isRecord(event.action) ? event.action : null;
  const value = isRecord(action?.value) ? action.value : null;
  const behavior = Array.isArray(action?.behaviors)
    ? (action.behaviors.find((item) => isRecord(item)) ?? null)
    : null;
  const behaviorValue = isRecord(behavior?.value) ? behavior.value : null;
  const text =
    readStringField(value, ["zcodeCardText", "cardText"]) ||
    readStringField(behaviorValue, ["zcodeCardText", "cardText"]);
  return text || null;
}

/** 飞书同步卡判定：card.action.trigger 载荷（WS 同步回卡路径，ack 短路用）。 */
export function isFeishuSynchronousCardAction(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (payload.zcodeFeishuSynchronousCardAction === true) return true;
  const event = isRecord(payload.event) ? payload.event : payload;
  const action = isRecord(event.action) ? event.action : null;
  return Boolean(action && (isRecord(action.value) || Array.isArray(action.behaviors)));
}

export function createFeishuBotProvider(options: FeishuProviderOptions = {}): BotProviderAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase ?? FEISHU_DOMAIN;
  const loadCredential = options.credentialLoader ?? (async () => null);
  const now = options.now ?? Date.now;
  const tokenCache = new Map<string, FeishuTokenCache>();

  const resolveAppCredentials = async (
    bot: BotConfig,
    credential?: string | null,
  ): Promise<{ appId: string; appSecret: string }> => {
    const secret =
      credential ?? (bot.credentialRef ? ((await loadCredential(bot.credentialRef)) ?? "") : "");
    return { appId: bot.feishuAppId ?? "", appSecret: secret };
  };

  /** tenant_access_token：缓存 90min，expiresAt > now+60s 短路复用（勘误后的刷新语义）。 */
  const getTenantAccessToken = async (
    bot: BotConfig,
    credential?: string | null,
  ): Promise<string> => {
    const { appId, appSecret } = await resolveAppCredentials(bot, credential);
    const cached = tokenCache.get(appId);
    if (cached && cached.expiresAt > now() + TOKEN_REFRESH_MARGIN_MS) return cached.token;
    const response = await fetchImpl(`${apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const result = (await response.json()) as {
      code?: number;
      tenant_access_token?: string;
      expire?: number;
      msg?: string;
    };
    if (!result.tenant_access_token) throw new Error(result.msg ?? "feishu token failed");
    const ttl = typeof result.expire === "number" ? result.expire * 1000 : TOKEN_TTL_MS;
    tokenCache.set(appId, { token: result.tenant_access_token, expiresAt: now() + ttl });
    return result.tenant_access_token;
  };

  /** POST `/open-apis/im/v1/messages` 创建 interactive 卡，返回 message_id（transient 卡句柄）。 */
  const createCard = async (
    bot: BotConfig,
    receiveId: string,
    card: Record<string, unknown>,
  ): Promise<string | null> => {
    const token = await getTenantAccessToken(bot);
    const receiveIdType = receiveId.startsWith("oc_") ? "chat_id" : "open_id";
    const response = await fetchImpl(`${apiBase}/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const result = (await response.json()) as { data?: { message_id?: string } };
    return result.data?.message_id ?? null;
  };

  /** PATCH `/open-apis/im/v1/messages/{id}` 更新卡片（用户点按钮后刷新交互状态）。 */
  const updateCard = async (
    bot: BotConfig,
    messageId: string,
    card: Record<string, unknown>,
  ): Promise<void> => {
    const token = await getTenantAccessToken(bot);
    await fetchImpl(`${apiBase}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ msg_type: "interactive", content: JSON.stringify(card) }),
      signal: AbortSignal.timeout(15_000),
    });
  };

  /** DELETE `/open-apis/im/v1/messages/{id}` 撤回卡片（官方 deleteTransientInteractionCard=Rde；host 全构建仅定义无调用点）。 */
  const recallCard = async (bot: BotConfig, messageId: string): Promise<void> => {
    const token = await getTenantAccessToken(bot);
    await fetchImpl(`${apiBase}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
  };

  /**
   * addFeishuTypingReaction（gZ）：POST `/open-apis/im/v1/messages/{id}/reactions`
   * `{reaction_type:{emoji_type:"Typing"}}`；同消息去重（py.has 短路），reaction_id 入表。
   */
  const addTypingReaction = async (bot: BotConfig, messageId: string): Promise<void> => {
    const token = await getTenantAccessToken(bot);
    if (!token) return;
    const key = getFeishuTypingReactionKey(bot, messageId);
    if (typingReactionIds.has(key)) return;
    const response = await fetchImpl(
      `${apiBase}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ reaction_type: { emoji_type: "Typing" } }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`Feishu add typing reaction failed: HTTP ${response.status}`);
    const result = (await response.json()) as {
      code?: number;
      msg?: string;
      data?: { reaction_id?: string };
    };
    if (result.code !== 0) throw new Error(result.msg || "Feishu add typing reaction failed.");
    if (result.data?.reaction_id) typingReactionIds.set(key, result.data.reaction_id);
  };

  /**
   * deleteFeishuTypingReaction（Ode）：DELETE `/open-apis/im/v1/messages/{id}/reactions/{rid}`。
   * 无登记 reaction_id 即短路（取消时机：stopTyping — 任务终态 K / 入站收口 G）。
   */
  const deleteTypingReaction = async (bot: BotConfig, messageId: string): Promise<void> => {
    const key = getFeishuTypingReactionKey(bot, messageId);
    const reactionId = typingReactionIds.get(key);
    if (!reactionId) return;
    const token = await getTenantAccessToken(bot);
    if (!token) return;
    const response = await fetchImpl(
      `${apiBase}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`Feishu delete typing reaction failed: HTTP ${response.status}`);
    const result = (await response.json()) as { code?: number; msg?: string };
    if (result.code !== 0) throw new Error(result.msg || "Feishu delete typing reaction failed.");
    typingReactionIds.delete(key);
  };

  const postCard = async (
    bot: BotConfig,
    outbound: OutboundMessage,
    locale: BotHostLocale,
  ): Promise<void> => {
    const card = createFeishuOutboundCard(outbound, locale);
    await createCard(bot, outbound.providerUserId, card);
  };

  return {
    provider: "feishu",
    async send(bot, outbound) {
      await postCard(bot, outbound, outbound.locale ?? "zh-CN");
    },
    /** transient 三段式①：POST 创建交互卡，返回 message_id 句柄。 */
    async createTransientInteractionCard(bot, outbound) {
      const card = createFeishuOutboundCard(outbound, outbound.locale ?? "zh-CN");
      const messageId = await createCard(bot, outbound.providerUserId, card);
      return messageId ? { providerMessageId: messageId } : null;
    },
    /** transient 三段式②：用户点按钮后 PATCH 更新卡内交互状态；收口（finalize）同样走本方法 PATCH 终态卡。 */
    async updateTransientInteractionCard(bot, handle, outbound) {
      const card = createFeishuOutboundCard(outbound, outbound.locale ?? "zh-CN");
      await updateCard(bot, handle.providerMessageId, card);
    },
    /** 官方 deleteTransientInteractionCard（Rde）：host 全构建仅定义、无任何调用点（收口=PATCH 终态卡+注销）。 */
    async deleteTransientInteractionCard(bot, handle) {
      await recallCard(bot, handle.providerMessageId);
    },
    /** typing= reaction（官方 sendTyping/startTyping 均 gZ）：POST Typing reaction 到入站消息，同消息去重。 */
    async sendTyping(bot, actor) {
      if (!actor.providerMessageId) return;
      await addTypingReaction(bot, actor.providerMessageId);
    },
    async startTyping(bot, actor) {
      if (!actor.providerMessageId) return;
      await addTypingReaction(bot, actor.providerMessageId);
    },
    /** 取消时机（官方 stopTyping=Ode）：按 reaction_id DELETE reaction；无登记短路。 */
    async stopTyping(bot, actor) {
      if (!actor.providerMessageId) return;
      await deleteTypingReaction(bot, actor.providerMessageId);
    },
    /** 卡片回执（card/update + token）；调用方对「飞书同步卡/已有 transient 卡无 elicitation」短路跳过。 */
    async acknowledgeCallback(bot, payload, text, firstReply, signal) {
      const updateToken = readFeishuCardUpdateToken(payload);
      if (!updateToken || (!text.trim() && !firstReply?.elicitation)) return;
      const token = await getTenantAccessToken(bot);
      const openIds = readFeishuCardUpdateOpenIds(payload);
      const cardText = readFeishuCardOriginalText(payload);
      const card = firstReply?.elicitation
        ? createFeishuOutboundCard(firstReply, firstReply.locale ?? "zh-CN")
        : buildFeishuSelectionCard(
            {
              botId: bot.id,
              provider: bot.provider as OutboundMessage["provider"],
              providerUserId: "",
              text: cardText?.trim() || text,
            },
            firstReply?.locale ?? "zh-CN",
          );
      const response = await fetchImpl(`${apiBase}/open-apis/interactive/v1/card/update`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          token: updateToken,
          ...(openIds.length > 0 ? { open_ids: openIds } : {}),
          card,
        }),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw new Error(`Feishu update interactive card failed: HTTP ${response.status}`);
      return firstReply?.elicitation ? { handled: true } : undefined;
    },
    async test(bot, credential): Promise<BotTestResult> {
      const { appId } = await resolveAppCredentials(bot, credential);
      await getTenantAccessToken(bot, credential);
      const token = tokenCache.get(appId)?.token ?? "";
      const response = await fetchImpl(
        `${apiBase}/open-apis/application/v6/applications/${appId || "me"}?lang=zh_cn`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
      );
      const result = (await response.json()) as { data?: { app?: { app_name?: string } } };
      const name = result.data?.app?.app_name;
      return { ok: true, ...(name ? { name } : {}), message: "ok", provider: bot.provider };
    },
    async resolveName(bot, credential) {
      const { appId } = await resolveAppCredentials(bot, credential);
      const token = await getTenantAccessToken(bot, credential);
      for (const target of appId ? [appId, "me"] : ["me"]) {
        try {
          const response = await fetchImpl(
            `${apiBase}/open-apis/application/v6/applications/${target}?lang=zh_cn`,
            { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
          );
          const result = (await response.json()) as { data?: { app?: { app_name?: string } } };
          const name = result.data?.app?.app_name;
          if (name) return name;
        } catch {
          // resolveName 重试由 saveBot 的重试表负责
        }
      }
      return undefined;
    },
    async parseCallback(bot, payload, _secret) {
      if (!bot) return { ok: false, messages: [], status: 400 };
      const messages = parseFeishuMessageEvent(bot.id, payload);
      return { ok: messages.length > 0, messages };
    },
    async downloadAttachment(bot, attachment) {
      const messageId = (attachment as unknown as { messageId?: string }).messageId;
      const fileKey = attachment.providerFileId ?? attachment.id;
      if (!messageId || !fileKey) return null;
      const token = await getTenantAccessToken(bot);
      const response = await fetchImpl(
        `${apiBase}/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${attachment.kind === "image" ? "image" : "file"}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) },
      );
      if (!response.ok) throw new Error(`file download failed: HTTP ${response.status}`);
      return { attachment, data: new Uint8Array(await response.arrayBuffer()) };
    },
  };
}

/** im.message.receive_v1 → InboundMessage（text/富文本/附件多键容错）。 */
export function parseFeishuMessageEvent(botId: string, payload: unknown): InboundMessage[] {
  const root = (payload ?? {}) as Record<string, unknown>;
  const event = (isRecord(root.event) ? root.event : root) as Record<string, unknown>;
  const message = (isRecord(event.message) ? event.message : {}) as Record<string, unknown>;
  const sender = (isRecord(event.sender) ? event.sender : {}) as Record<string, unknown>;
  const senderId = (isRecord(sender.sender_id) ? sender.sender_id : {}) as Record<string, unknown>;
  const providerUserId =
    (typeof senderId.open_id === "string" ? senderId.open_id : undefined) ??
    (typeof senderId.user_id === "string" ? senderId.user_id : undefined);
  if (!providerUserId) return [];
  let text = "";
  try {
    const content = JSON.parse(String(message.content ?? "{}")) as Record<string, unknown>;
    if (typeof content.text === "string") text = content.text;
  } catch {
    text = "";
  }
  const chatId = typeof message.chat_id === "string" ? message.chat_id : undefined;
  const messageId = typeof message.message_id === "string" ? message.message_id : undefined;
  // 附件经 message.resources 拉取（downloadAttachment 用 messageId+file_key）；此处仅登记 file 类占位
  const attachments: BotAttachment[] = [];
  const actor: BotActor = {
    provider: "feishu",
    botId,
    providerUserId,
    chatType: message.chat_type === "p2p" ? "private" : "group",
    ...(chatId ? { chatId } : {}),
    ...(messageId ? { providerMessageId: messageId } : {}),
  };
  if (!text && attachments.length === 0) return [];
  return [
    {
      botId,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      actor,
    },
  ];
}

// ── accounts device-code 注册（/oauth/v1/app/registration） ──

interface AccountsFormOptions {
  fetchImpl: typeof fetch;
  domain: string;
}

async function accountsPost(
  options: AccountsFormOptions,
  form: Record<string, string>,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ ...form }).toString();
  const response = await options.fetchImpl(`${options.domain}/oauth/v1/app/registration`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  return (await response.json()) as Record<string, unknown>;
}

/** action=begin&archetype=PersonalAgent&auth_method=client_secret&request_user_info=open_id。 */
export async function beginFeishuAccountsRegistration(
  fetchImpl: typeof fetch,
  domain: "feishu" | "lark" = "feishu",
  now: () => number = Date.now,
): Promise<FeishuRegistrationBegin> {
  const options: AccountsFormOptions = {
    fetchImpl,
    domain: resolveFeishuAccountsDomain(domain),
  };
  await accountsPost(options, { action: "init" });
  const result = await accountsPost(options, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
    source: "node-sdk/zcode",
    tp: "sdk",
  });
  const deviceCode = String(result.device_code ?? "");
  const verificationUri = String(result.verification_uri_complete ?? "");
  const interval = typeof result.interval === "number" && result.interval > 0 ? result.interval : 5;
  const expireIn = typeof result.expire_in === "number" ? result.expire_in : 600;
  return {
    deviceCode,
    qrUrl: verificationUri,
    ...(typeof result.user_code === "string" ? { userCode: result.user_code } : {}),
    interval,
    expiresAt: now() + expireIn * 1000,
    domain,
  };
}

export async function pollFeishuAccountsRegistration(
  fetchImpl: typeof fetch,
  params: { deviceCode: string; domain?: "feishu" | "lark"; pollDomain?: "feishu" | "lark" },
): Promise<FeishuRegistrationPoll> {
  const domain = params.pollDomain ?? params.domain ?? "feishu";
  const result = await accountsPost(
    { fetchImpl, domain: resolveFeishuAccountsDomain(domain) },
    { action: "poll", device_code: params.deviceCode },
  );
  const status = String(result.status ?? result.error ?? "");
  if (result.client_id && result.client_secret) {
    const userInfo = (result.user_info ?? {}) as Record<string, unknown>;
    const pollDomain = userInfo.tenant_brand === "lark" ? "lark" : undefined;
    if (pollDomain && pollDomain !== domain) {
      return { status: "pending" };
    }
    return {
      status: "success",
      appId: String(result.client_id),
      appSecret: String(result.client_secret),
      ...(typeof result.app_name === "string" ? { appName: result.app_name } : {}),
      ...(typeof userInfo.open_id === "string" ? { openId: userInfo.open_id } : {}),
    };
  }
  if (status === "authorization_pending") return { status: "pending" };
  if (status === "slow_down") return { status: "pending" };
  if (status === "access_denied") return { status: "access_denied" };
  if (status === "expired_token") return { status: "expired" };
  return { status: "error", message: String(result.error_description ?? status ?? "error") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { BotSelection, BotDeliveryTarget };
