// FreeCodeZ fork(Bots):Telegram setMyCommands 映射/过滤/接线 + sendChatAction typing 重发停止（附录B §3.1/核心常量 4000ms）
// + callback 应答（官方 @635279/635513：answerCallbackQuery toast 180 截断 + editMessageReplyMarkup 清键盘）
// + runtime 长轮询路径 ack 接线（官方 Yd 时机：处理后、发送环前）。
// 运行: node --import tsx --test packages/services/test/botsTelegram.test.ts。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotActor, BotConfig, BotContext, InboundMessage } from "@zcode/shared/bots";
import type { ICredentialService } from "../src/credential/credential.js";
import {
  buildTelegramCommandList,
  createTelegramBotProvider,
  readTelegramCallbackId,
  readTelegramCallbackMessageRef,
  syncTelegramMyCommands,
  truncateCallbackToast,
  TELEGRAM_COMMAND_MAP,
} from "../src/bots/providers/telegramProvider.js";
import {
  createBotsService,
  type BotRuntimeFactoryContext,
} from "../src/bots/botsService.js";
import { BotTaskBridge } from "../src/bots/taskBridge.js";
import { BotsRepo } from "../src/bots/botsRepo.js";
import { BotResourceRegistry } from "../src/bots/resourceRegistry.js";
import type { BotTaskServiceLike, BotTaskStreamEvent } from "../src/bots/taskServiceLike.js";

const telegramBot: BotConfig = {
  id: "tg-1",
  name: "tg",
  provider: "telegram",
  enabled: true,
  credentialRef: "bot:tg-1:credential",
  providerUserId: "owner",
  allowedWorkspaces: [],
  allowedCommands: {
    status: true,
    workspace: true,
    new: true,
    model: true,
    thoughtLevel: true,
    reply: true,
  },
  currentOptions: {},
  replyMode: "assistant_changes",
};

const privateActor: BotActor = {
  provider: "telegram",
  botId: "tg-1",
  providerUserId: "user-1",
  chatType: "private",
};

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface RecordedFetchCall {
  url: string;
  method: string;
  body: unknown;
}

function makeFetchRecorder(): {
  fetchImpl: typeof fetch;
  calls: RecordedFetchCall[];
} {
  const calls: RecordedFetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("setMyCommands 映射：bind/help/status/new/workspace→project/model/mode/thoughtLevel→think/reply", () => {
  const commands = buildTelegramCommandList(telegramBot.allowedCommands);
  assert.deepEqual(
    commands.map((entry) => entry.command),
    ["bind", "help", "status", "new", "project", "model", "mode", "think", "reply"],
  );
  assert.deepEqual(
    TELEGRAM_COMMAND_MAP.map((entry) => entry.command),
    ["bind", "help", "status", "new", "project", "model", "mode", "think", "reply"],
  );
});

test("setMyCommands 过滤：allowedCommands false 剔除，help/bind 恒在", () => {
  const commands = buildTelegramCommandList({
    status: false,
    workspace: true,
    new: false,
    model: false,
    thoughtLevel: true,
    reply: false,
    mode: false,
  });
  assert.deepEqual(
    commands.map((entry) => entry.command),
    ["bind", "help", "project", "think"],
  );
  const minimal = buildTelegramCommandList({
    status: false,
    workspace: false,
    new: false,
    model: false,
    thoughtLevel: false,
    reply: false,
    mode: false,
  });
  assert.deepEqual(
    minimal.map((entry) => entry.command),
    ["bind", "help"],
  );
});

test("syncCommands 接线：启用 → setMyCommands{commands}；停用 → deleteMyCommands{}", async () => {
  const { fetchImpl, calls } = makeFetchRecorder();
  const provider = createTelegramBotProvider({
    fetchImpl,
    credentialLoader: async () => "token-1",
  });
  await provider.syncCommands?.(telegramBot);
  assert.equal(calls[0]?.url, "https://api.telegram.org/bottoken-1/setMyCommands");
  assert.deepEqual(calls[0]?.body, {
    commands: buildTelegramCommandList(telegramBot.allowedCommands),
  });
  await provider.syncCommands?.({ ...telegramBot, enabled: false });
  assert.equal(calls[1]?.url, "https://api.telegram.org/bottoken-1/deleteMyCommands");
  assert.deepEqual(calls[1]?.body, {});
});

test("syncTelegramMyCommands：token 为空静默跳过（runtime 启动复用同一构造器）", async () => {
  const { fetchImpl, calls } = makeFetchRecorder();
  await syncTelegramMyCommands(fetchImpl, "https://api.telegram.org", "  ", telegramBot);
  assert.equal(calls.length, 0);
  await syncTelegramMyCommands(fetchImpl, "https://api.telegram.org", "tok", telegramBot);
  assert.equal(calls[0]?.url, "https://api.telegram.org/bottok/setMyCommands");
});

test("sendChatAction typing 发到 chatId ?? providerUserId", async () => {
  const { fetchImpl, calls } = makeFetchRecorder();
  const provider = createTelegramBotProvider({
    fetchImpl,
    credentialLoader: async () => "token-1",
  });
  await provider.sendTyping?.(telegramBot, {
    ...privateActor,
    chatType: "group",
    chatId: "chat-9",
  });
  assert.equal(calls[0]?.url, "https://api.telegram.org/bottoken-1/sendChatAction");
  assert.deepEqual(calls[0]?.body, { chat_id: "chat-9", action: "typing" });
  await provider.sendTyping?.(telegramBot, privateActor);
  assert.deepEqual(calls[1]?.body, { chat_id: "user-1", action: "typing" });
});

function makeTaskBridgeForTyping(options: {
  onTyping: () => void;
  typingResendMs: number;
  registry?: BotResourceRegistry;
  onStreamHandler?: (handler: (event: BotTaskStreamEvent) => void) => void;
}): BotTaskBridge {
  const taskService = {
    onDynamicTaskEvent() {
      return (handler: (event: BotTaskStreamEvent) => void) => {
        options.onStreamHandler?.(handler);
        return { dispose() {} };
      };
    },
  } as unknown as BotTaskServiceLike;
  return new BotTaskBridge({
    taskService,
    repo: new BotsRepo({ configDir: process.env.TEMP ?? process.env.TMPDIR ?? "." }),
    resourceRegistry: options.registry ?? new BotResourceRegistry(),
    sendOutbound: async () => undefined,
    sendTyping: async () => {
      options.onTyping();
    },
    logger: noopLogger,
    now: () => 0,
    typingResendMs: options.typingResendMs,
  });
}

test("typing 重发停止：入站即发 + 节奏重发 + stop 后不再发", async () => {
  let sent = 0;
  const bridge = makeTaskBridgeForTyping({
    onTyping: () => {
      sent += 1;
    },
    typingResendMs: 15,
  });
  const stop = bridge.startTyping(telegramBot, privateActor, "task-1");
  // 入站开始处理即发一次
  assert.equal(sent, 1);
  await sleep(150);
  // 4000ms 节奏（测试注入 15ms）重发
  assert.ok(sent >= 3, `expected typing resends, got ${sent}`);
  stop();
  const afterStop = sent;
  await sleep(80);
  assert.equal(sent, afterStop, "stop 后 typing 不再重发");
  stop();
  assert.equal(sent, afterStop, "stop 幂等");
});

test("typing 生命周期：watchTaskStream 终态停止 typing 并释放登记（R13）", async () => {
  let sent = 0;
  const registry = new BotResourceRegistry();
  let emit: ((event: BotTaskStreamEvent) => void) | undefined;
  const bridge = makeTaskBridgeForTyping({
    onTyping: () => {
      sent += 1;
    },
    typingResendMs: 15,
    registry,
    onStreamHandler: (handler) => {
      emit = handler;
    },
  });
  const watch = bridge.watchTaskStream({
    bot: telegramBot,
    actor: privateActor,
    context: {
      botId: "tg-1",
      workspacePath: "/w",
      mode: "task",
      activeTaskId: "task-1",
      updatedAt: 0,
    } as BotContext,
    locale: "zh-CN",
    taskId: "task-1",
  });
  assert.ok(emit);
  await sleep(150);
  assert.ok(sent >= 2, `expected typing resends, got ${sent}`);
  // 任务终态：typing 停止 + 流订阅/typing 登记释放
  emit?.({ type: "task_complete", taskId: "task-1" } as unknown as BotTaskStreamEvent);
  await sleep(30);
  const afterTerminal = sent;
  await sleep(80);
  assert.equal(sent, afterTerminal, "终态后 typing 停止");
  assert.equal(registry.size, 0, "终态后登记表无残留");
  watch.dispose();
});

// ── callback 应答（官方 acknowledgeCallback @635279/635513） ──

const callbackPayload = {
  botId: "tg-1",
  update: {
    update_id: 7,
    callback_query: {
      id: "cbq-9",
      data: "zc:cancel",
      message: { chat: { id: 5, type: "private" }, message_id: 9 },
    },
  },
};

test("TG callback 应答：answerCallbackQuery（toast 180 截断）+ editMessageReplyMarkup 清键盘", async () => {
  // nce/rce 提取：`payload.update ?? payload` 容忍两种形态
  assert.equal(readTelegramCallbackId(callbackPayload), "cbq-9");
  assert.equal(readTelegramCallbackId({ callback_query: { id: "raw" } }), "raw");
  assert.deepEqual(readTelegramCallbackMessageRef(callbackPayload), {
    chatId: "5",
    messageId: 9,
  });
  assert.equal(truncateCallbackToast("  已提交   权限响应\n"), "已提交 权限响应");
  assert.equal(truncateCallbackToast("z".repeat(300)), `${"z".repeat(177)}...`);

  const { fetchImpl, calls } = makeFetchRecorder();
  const provider = createTelegramBotProvider({
    fetchImpl,
    credentialLoader: async () => "token-1",
  });
  await provider.acknowledgeCallback?.(telegramBot, callbackPayload, "  已提交   权限响应  ");
  assert.equal(calls[0]?.url, "https://api.telegram.org/bottoken-1/answerCallbackQuery");
  // 官方 `{callback_query_id:l,...s?.trim()?{text:Jae(s)}:{}}`：Jae=trim+折叠空白+180 截断
  assert.deepEqual(calls[0]?.body, { callback_query_id: "cbq-9", text: "已提交 权限响应" });
  assert.equal(calls[1]?.url, "https://api.telegram.org/bottoken-1/editMessageReplyMarkup");
  assert.deepEqual(calls[1]?.body, {
    chat_id: "5",
    message_id: 9,
    reply_markup: { inline_keyboard: [] },
  });
});

test("TG callback 应答：toast 文本空 → 不带 text 且不清键盘（官方 `u&&s?.trim()&&`）", async () => {
  const { fetchImpl, calls } = makeFetchRecorder();
  const provider = createTelegramBotProvider({
    fetchImpl,
    credentialLoader: async () => "token-1",
  });
  await provider.acknowledgeCallback?.(telegramBot, callbackPayload, "   ");
  assert.equal(calls.length, 1, "文本空只应答不清键盘");
  assert.deepEqual(calls[0]?.body, { callback_query_id: "cbq-9" });
});

test("TG callback 应答：无 callback_query 不发请求；清键盘失败静默、answerCallbackQuery 失败上抛", async () => {
  const noop = makeFetchRecorder();
  const providerNoop = createTelegramBotProvider({
    fetchImpl: noop.fetchImpl,
    credentialLoader: async () => "token-1",
  });
  await providerNoop.acknowledgeCallback?.(telegramBot, { update: { message: {} } }, "hi");
  assert.equal(noop.calls.length, 0, "无 callback id 短路");

  // 清键盘失败 → 静默吞掉
  let step = 0;
  const tolerantFetch = (async (input: RequestInfo | URL) => {
    step += 1;
    if (String(input).includes("editMessageReplyMarkup")) throw new Error("markup down");
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const tolerant = createTelegramBotProvider({
    fetchImpl: tolerantFetch,
    credentialLoader: async () => "token-1",
  });
  await tolerant.acknowledgeCallback?.(telegramBot, callbackPayload, "ok");
  assert.ok(step >= 2);

  // answerCallbackQuery 失败 → 上抛（外层 Yd 捕获告警）
  const strictFetch = (async () => {
    throw new Error("answer down");
  }) as unknown as typeof fetch;
  const strict = createTelegramBotProvider({
    fetchImpl: strictFetch,
    credentialLoader: async () => "token-1",
  });
  await assert.rejects(() =>
    Promise.resolve(strict.acknowledgeCallback?.(telegramBot, callbackPayload, "ok")),
  );
});

test("runtime 长轮询路径接线：handleInboundMessage 处理后 ack（answerCallbackQuery + 清键盘）", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "bots-tg-ack-"));
  try {
    const { fetchImpl, calls } = makeFetchRecorder();
    const provider = createTelegramBotProvider({
      fetchImpl,
      credentialLoader: async () => "token-1",
    });
    const credentialService = {
      async load() {
        return "token-1";
      },
      async save() {},
      async delete() {},
    } as unknown as ICredentialService;
    const taskService = {
      onDynamicTaskEvent() {
        return (_handler: (event: BotTaskStreamEvent) => void) => ({ dispose() {} });
      },
    } as unknown as BotTaskServiceLike;
    let runtimeCtx: BotRuntimeFactoryContext | undefined;
    // telegramRuntime 把 `{botId, update}` 作为 payload 下传（官方 `processProviderCallback("telegram",{botId,update:D})`）
    const service = createBotsService({
      configDir,
      credentialService,
      taskService,
      adapters: [provider],
      runStartupBackgroundTasks: false,
      createRuntimes: (ctx) => {
        runtimeCtx = ctx;
        return [];
      },
      listWorkspaceRefs: async () => [{ id: "ws-1", label: "ws-1", workspacePath: "/ws-1" }],
    });
    await service.saveConfig({ version: 3, bots: [telegramBot] });
    assert.ok(runtimeCtx);
    const message: InboundMessage = {
      botId: "tg-1",
      text: "/help",
      actor: {
        provider: "telegram",
        botId: "tg-1",
        providerUserId: "owner",
        chatType: "private",
        providerMessageId: "m-1",
      },
    };
    await runtimeCtx.handleInboundMessage(message, callbackPayload);
    const ack = calls.find((call) => call.url.endsWith("/answerCallbackQuery"));
    assert.ok(ack, "runtime 路径已接线 answerCallbackQuery（应答时机=处理后）");
    const ackBody = ack.body as { callback_query_id: string; text?: string };
    assert.equal(ackBody.callback_query_id, "cbq-9");
    assert.ok(String(ackBody.text).includes("FreeCodeZ 机器人命令"), String(ackBody.text));
    const cleared = calls.find((call) => call.url.endsWith("/editMessageReplyMarkup"));
    assert.ok(cleared, "runtime 路径已接线清键盘");
    assert.deepEqual(cleared.body, {
      chat_id: "5",
      message_id: 9,
      reply_markup: { inline_keyboard: [] },
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
