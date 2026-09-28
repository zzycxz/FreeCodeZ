// FreeCodeZ fork(Bots):TG callback_data 编解码 round-trip（附录B §1.4）+ webhook/weixin 入站解析。
// 运行: node --test packages/services/test/botsCallback.test.ts（经 tsx 加载源码）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSelectionCallbackData,
  decodeTelegramCallbackData,
  parseBotCommand,
} from "@zcode/shared/bots";
import { parseTelegramCallbackQuery } from "../src/bots/providers/telegramProvider.js";
import {
  parseWebhookInbound,
  unwrapWebhookPayload,
} from "../src/bots/providers/webhookProvider.js";
import {
  parseWeixinUpdates,
  extractWeixinUpdatesCursor,
  normalizeWeixinQrStatus,
} from "../src/bots/providers/weixinProvider.js";

test("callback round-trip：全部 action 编码→解码→parseBotCommand", () => {
  const cases: Array<{ spec: Parameters<typeof buildSelectionCallbackData>[0]; expectedType: string }> = [
    { spec: { action: "workspace.set", index: 1 }, expectedType: "workspace.set" },
    { spec: { action: "mode.set", index: 2 }, expectedType: "mode.set" },
    { spec: { action: "thoughtLevel.set", index: 3 }, expectedType: "thoughtLevel.set" },
    { spec: { action: "task.set", index: 4 }, expectedType: "task.set" },
    { spec: { action: "reply.set", index: 1 }, expectedType: "reply.set" },
    { spec: { action: "model.provider.set", index: 2 }, expectedType: "model.provider.set" },
    { spec: { action: "model.set", index: 3 }, expectedType: "model.set" },
  ];
  for (const { spec, expectedType } of cases) {
    const decoded = decodeTelegramCallbackData(buildSelectionCallbackData(spec));
    const parsed = parseBotCommand(decoded);
    assert.equal(parsed.type, expectedType, decoded);
    if (parsed.type !== "message" && "value" in parsed) {
      assert.equal(parsed.value, String(spec.index), decoded);
    }
  }
});

test("callback round-trip：permission / elicitation / cancel", () => {
  // permission.respond → zc:permission:<n> → /permission <n>
  const permission = decodeTelegramCallbackData(
    buildSelectionCallbackData({ action: "permission.respond", index: 2 }),
  );
  assert.equal(permission, "/permission 2");
  assert.deepEqual(parseBotCommand(permission), { type: "permission.respond", value: "2" });

  // elicitation.respond 无 token → zc:elicitation:<n>
  const plain = decodeTelegramCallbackData(
    buildSelectionCallbackData({ action: "elicitation.respond", index: 1 }),
  );
  assert.equal(plain, "/elicitation 1");

  // elicitation.respond 带 token → zc:e:<token>:<n> → /elicitation <token> <n>
  const withToken = decodeTelegramCallbackData(
    buildSelectionCallbackData({ action: "elicitation.respond", index: 3, token: "abc123def456" }),
  );
  assert.equal(withToken, "/elicitation abc123def456 3");

  // 取消
  assert.equal(
    decodeTelegramCallbackData(buildSelectionCallbackData({ action: "workspace.set", index: 1, cancel: true })),
    "/cancel",
  );
  assert.equal(decodeTelegramCallbackData("zc:cancel"), "/cancel");
  // 非 zc:* 前缀原样返回
  assert.equal(decodeTelegramCallbackData("plain"), "plain");
});

test("TG callback_query 解析为文本命令 InboundMessage", () => {
  const message = parseTelegramCallbackQuery("bot-1", {
    id: "cbq-1",
    data: "zc:workspace:2",
    from: { id: 77, username: "u" },
    message: { chat: { id: 5, type: "private" }, message_id: 9 },
  });
  assert.ok(message);
  assert.equal(message.text, "/workspace 2");
  assert.equal(message.actor.providerUserId, "77");
  assert.equal(message.actor.chatId, "5");
  assert.equal(message.actor.chatType, "private");
});

test("webhook 入站解析：messageId|id、attachments、elicitationResponse", () => {
  const parsed = parseWebhookInbound({
    botId: "w1",
    text: "/bind ABCDEF",
    userId: "u-1",
    displayName: "U",
    chatType: "private",
    id: "m-1",
    attachments: [{ kind: "file", filename: "a.txt" }],
    elicitationResponse: { type: "zcode.bot.elicitation_response", requestId: "r1", action: "accept" },
  });
  assert.ok(parsed.ok);
  const message = parsed.messages[0];
  assert.ok(message);
  assert.equal(message.text, "/bind ABCDEF");
  assert.equal(message.actor.providerMessageId, "m-1");
  assert.equal(message.attachments?.length, 1);
  assert.ok(message.elicitationResponse);
  // {headers, body} 信封同样可解析
  const enveloped = parseWebhookInbound({
    headers: { "x-zcode-bot-secret": "s" },
    body: { botId: "w1", text: "hi", userId: "u-1", chatType: "group", chatId: "g-1", messageId: "m-2" },
  });
  assert.ok(enveloped.ok);
  assert.equal(enveloped.messages[0]?.actor.chatType, "group");
  assert.equal(enveloped.messages[0]?.actor.chatId, "g-1");
  // 缺 botId/userId → 400
  assert.equal(parseWebhookInbound({ text: "x" }).ok, false);
  assert.equal(unwrapWebhookPayload(null).body, null);
});

test("微信 getupdates 解析：多键容错 + message_type===2 丢弃 + 游标 6 键 fallback", () => {
  const messages = parseWeixinUpdates("wb", {
    messages: [
      {
        msg: {
          message_type: 1,
          ilink_user_id: "wx-1",
          chat_id: "wx-1",
          msg_id: "m1",
          item_list: [{ type: 1, text_item: { text: "hello" } }],
        },
      },
      { message_type: 2, from_user_id: "wx-2", text: "outbound echo" },
      { msg: { user_id: "wx-3", text: "fallback keys" } },
    ],
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.text, "hello");
  assert.equal(messages[0]?.actor.providerMessageId, "m1");
  assert.equal(messages[1]?.text, "fallback keys");
  assert.equal(messages[1]?.actor.providerUserId, "wx-3");

  assert.equal(extractWeixinUpdatesCursor({ get_updates_buf: "abc" }), "abc");
  assert.equal(extractWeixinUpdatesCursor({ next_cursor: 5 }), "5");
  assert.equal(extractWeixinUpdatesCursor({}), undefined);

  assert.deepEqual(normalizeWeixinQrStatus({ status: 0 }), { status: "pending" });
  assert.deepEqual(normalizeWeixinQrStatus({ status: "scanned" }), { status: "scanned" });
  assert.deepEqual(normalizeWeixinQrStatus({ status: 2, bot_token: "t", ilink_bot_id: "b" }), {
    status: "success",
    botToken: "t",
    botId: "b",
  });
  assert.equal(normalizeWeixinQrStatus({ status: 3 }).status, "expired");
  assert.equal(normalizeWeixinQrStatus({ status: "weird" }).status, "error");
});
