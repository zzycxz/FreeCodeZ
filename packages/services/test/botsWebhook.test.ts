// FreeCodeZ fork(Bots):webhook 入站鉴权 body `webhookSecret` 权威语义（官方 Yd @762857-763353：
// 凭据空跳过；失配丢弃该条并回 webhookSecretInvalid，整体 status 200；飞书族比对 payload.token|payload.header.token）
// + 出站 `x-zcode-bot-secret` 头（官方 send/test）+ 3 重试语义。
// 运行: node --import tsx --test packages/services/test/botsWebhook.test.ts。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotConfig, BotProviderAdapter, OutboundMessage } from "@zcode/shared/bots";
import type { ICredentialService } from "../src/credential/credential.js";
import {
  WEBHOOK_SECRET_HEADER_NAME,
  createWebhookBotProvider,
  parseWebhookInbound,
  postWebhookWithRetry,
  readFeishuVerificationToken,
  readWebhookSecretField,
  verifyWebhookSecret,
  buildWebhookSelectionText,
} from "../src/bots/providers/webhookProvider.js";
import { createBotsService } from "../src/bots/botsService.js";
import type { IBotsService } from "../src/bots/bots.js";
import type { BotTaskServiceLike, BotTaskStreamEvent } from "../src/bots/taskServiceLike.js";

const webhookBot: BotConfig = {
  id: "w1",
  name: "hook",
  provider: "webhook",
  enabled: true,
  webhookUrl: "https://example.test/hook",
  webhookAuthHeaderName: "x-zcode-bot-secret",
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

test("webhook secret：body webhookSecret 权威（header 不作鉴权依据）", () => {
  // 官方 `Je=typeof V.webhookSecret=="string"?V.webhookSecret:void 0`：只读 body 顶层字段
  assert.equal(readWebhookSecretField({ webhookSecret: "s3cret" }), "s3cret");
  assert.equal(readWebhookSecretField({ body: { webhookSecret: "s3cret" } }), "s3cret");
  assert.equal(readWebhookSecretField({ headers: { "x-zcode-bot-secret": "s3cret" } }), undefined);
  // header 即便命中也不作依据
  assert.deepEqual(
    verifyWebhookSecret("s3cret", {
      headers: { "x-zcode-bot-secret": "s3cret" },
      body: { webhookSecret: "wrong" },
    }),
    { ok: false, reason: "mismatch" },
  );
  assert.deepEqual(
    verifyWebhookSecret("s3cret", { headers: { "x-zcode-bot-secret": "s3cret" } }),
    { ok: false, reason: "mismatch" },
  );
  // body 命中放行
  assert.deepEqual(verifyWebhookSecret("s3cret", { webhookSecret: "s3cret" }), { ok: true });
  assert.deepEqual(verifyWebhookSecret("s3cret", { body: { webhookSecret: "s3cret" } }), {
    ok: true,
  });
  // 凭据空跳过校验（官方 `if(We&&We!==Je)`：We 空即不校验）
  assert.deepEqual(verifyWebhookSecret(null, {}), {
    ok: true,
    reason: "no-secret-configured",
  });
  assert.deepEqual(verifyWebhookSecret("", { webhookSecret: "x" }), {
    ok: true,
    reason: "no-secret-configured",
  });
  // 凭据非空但 body 字段缺失 → 失配（官方 `We!==Je`，Je=undefined 即不等）
  assert.deepEqual(verifyWebhookSecret("s3cret", { body: {} }), {
    ok: false,
    reason: "mismatch",
  });
  // 飞书族：payload.token | payload.header.token
  assert.equal(readFeishuVerificationToken({ token: "vt" }), "vt");
  assert.equal(readFeishuVerificationToken({ header: { token: "vt2" } }), "vt2");
  assert.equal(readFeishuVerificationToken({ token: 42, header: { token: "vt2" } }), "vt2");
  assert.equal(readFeishuVerificationToken({}), undefined);
});

test("webhook parseCallback：纯解析，secret 校验上移到 Yd 逐条比对", async () => {
  const provider = createWebhookBotProvider({ fetchImpl: fetch });
  const parsed = await provider.parseCallback(
    webhookBot,
    {
      body: {
        botId: "w1",
        text: "/help",
        userId: "u1",
        chatType: "private",
        messageId: "m1",
        webhookSecret: "wrong",
      },
    },
    "s3cret",
  );
  // 不再返回 401：解析照常产出消息，鉴权由 processProviderCallback 逐条处理
  assert.ok(parsed.ok);
  assert.equal(parsed.status, undefined);
  assert.equal(parsed.messages[0]?.text, "/help");
});

interface AuthHarness {
  service: IBotsService;
  configDir: string;
}

async function makeAuthHarness(params: {
  webhookSecretValue: string | null;
  feishuSecretValue?: string | null;
}): Promise<AuthHarness> {
  const configDir = await mkdtemp(join(tmpdir(), "bots-auth-"));
  const credentialService = {
    async load(key: string) {
      if (key === "bot:w1:webhook-secret") return params.webhookSecretValue;
      if (key === "bot:fs-1:webhook-secret") return params.feishuSecretValue ?? null;
      return null;
    },
    async save() {},
    async delete() {},
  } as unknown as ICredentialService;
  const taskService = {
    onDynamicTaskEvent() {
      return (_handler: (event: BotTaskStreamEvent) => void) => ({ dispose() {} });
    },
  } as unknown as BotTaskServiceLike;
  const webhookAdapter: BotProviderAdapter = {
    provider: "webhook",
    async send() {},
    async test() {
      return { ok: true, message: "ok", provider: "webhook" };
    },
    async parseCallback(_bot, payload) {
      const parsed = parseWebhookInbound(payload);
      return {
        ok: parsed.ok,
        messages: parsed.messages,
        ...(parsed.status ? { status: parsed.status } : {}),
      };
    },
  };
  const feishuAdapter: BotProviderAdapter = {
    provider: "feishu",
    async send() {},
    async test() {
      return { ok: true, message: "ok", provider: "feishu" };
    },
    async parseCallback(bot, payload) {
      const record = (payload ?? {}) as Record<string, unknown>;
      const message = {
        botId: bot?.id ?? "fs-1",
        text: typeof record.text === "string" ? record.text : "/help",
        actor: {
          provider: "feishu" as const,
          botId: bot?.id ?? "fs-1",
          providerUserId: "ou_user",
          chatType: "private" as const,
          providerMessageId: "om_1",
        },
      };
      return { ok: true, messages: [message] };
    },
  };
  const service = createBotsService({
    configDir,
    credentialService,
    taskService,
    adapters: [webhookAdapter, feishuAdapter],
    runStartupBackgroundTasks: false,
    createRuntimes: () => [],
    listWorkspaceRefs: async () => [{ id: "ws-1", label: "ws-1", workspacePath: "/ws-1" }],
  });
  await service.saveConfig({
    version: 3,
    bots: [
      {
        ...webhookBot,
        // webhookSecretRef 恒在：凭据 load 结果控制“跳过（凭据空）/失配/命中”
        webhookSecretRef: "bot:w1:webhook-secret",
        providerUserId: "u1",
      },
      {
        id: "fs-1",
        name: "fs",
        provider: "feishu",
        enabled: true,
        providerUserId: "ou_user",
        feishuAppId: "cli_0123456789abcdef",
        credentialRef: "bot:fs-1:credential",
        webhookSecretRef:
          params.feishuSecretValue === undefined || params.feishuSecretValue === null
            ? undefined
            : "bot:fs-1:webhook-secret",
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
      },
    ],
  });
  return { service, configDir };
}

test("webhook body 权威语义：失配丢弃该条回 webhookSecretInvalid，整体 status 200", async () => {
  const harness = await makeAuthHarness({ webhookSecretValue: "s3cret" });
  try {
    const result = await harness.service.handleProviderCallbackResponse("webhook", {
      botId: "w1",
      text: "/help",
      userId: "u1",
      chatType: "private",
      messageId: "m-bad",
      webhookSecret: "wrong",
    });
    assert.equal(result.ok, true, "失配不置 failed（官方 Ve 不置位）");
    assert.equal(result.status, undefined, "整体 status 200（无 status 字段）");
    assert.equal(result.replies.length, 1);
    assert.equal(result.replies[0]?.text, "Webhook secret 校验失败。");
    // 丢弃该条：不处理 /help（无帮助文本回执）
    assert.ok(!result.replies.some((reply: OutboundMessage) => reply.text.includes("FreeCodeZ 机器人命令")));
  } finally {
    await rm(harness.configDir, { recursive: true, force: true });
  }
});

test("webhook body 权威语义：凭据空跳过校验、命中放行", async () => {
  // 凭据空（load→null）：跳过校验，照常处理
  const skipped = await makeAuthHarness({ webhookSecretValue: null });
  try {
    const result = await skipped.service.handleProviderCallbackResponse("webhook", {
      botId: "w1",
      text: "/help",
      userId: "u1",
      chatType: "private",
      messageId: "m-skip",
    });
    assert.equal(result.ok, true);
    assert.ok(result.replies.some((reply) => reply.text.includes("FreeCodeZ 机器人命令")), "凭据空跳过校验后正常处理");
  } finally {
    await rm(skipped.configDir, { recursive: true, force: true });
  }
  // 命中：照常处理
  const matched = await makeAuthHarness({ webhookSecretValue: "s3cret" });
  try {
    const result = await matched.service.handleProviderCallbackResponse("webhook", {
      botId: "w1",
      text: "/help",
      userId: "u1",
      chatType: "private",
      messageId: "m-ok",
      webhookSecret: "s3cret",
    });
    assert.ok(result.replies.some((reply) => reply.text.includes("FreeCodeZ 机器人命令")));
  } finally {
    await rm(matched.configDir, { recursive: true, force: true });
  }
});

test("飞书族入站鉴权：payload.token|payload.header.token 比对（失配丢弃）", async () => {
  const harness = await makeAuthHarness({
    webhookSecretValue: null,
    feishuSecretValue: "vt-secret",
  });
  try {
    // header.token 失配 → 丢弃 + webhookSecretInvalid
    const bad = await harness.service.handleProviderCallbackResponse("feishu", {
      text: "/help",
      header: { token: "wrong" },
    });
    assert.equal(bad.replies.length, 1);
    assert.equal(bad.replies[0]?.text, "Webhook secret 校验失败。");
    assert.equal(bad.status, undefined);
    // 顶层 token 命中 → 正常处理
    const ok = await harness.service.handleProviderCallbackResponse("feishu", {
      text: "/help",
      token: "vt-secret",
      messageId: "om-ok",
    });
    assert.ok(ok.replies.some((reply) => reply.text.includes("FreeCodeZ 机器人命令")));
  } finally {
    await rm(harness.configDir, { recursive: true, force: true });
  }
});

test("postWebhookWithRetry：[0,500,1500]ms×3；2xx/4xx 立即返回；5xx/网络错重试", async () => {
  const makeFetch = (statuses: number[]): { calls: number[]; fetchImpl: typeof fetch } => {
    const calls: number[] = [];
    const fetchImpl = (async () => {
      const index = calls.length;
      calls.push(index);
      const status = statuses[index] ?? 0;
      if (status === 0) throw new Error("network down");
      return new Response(status === 204 ? null : "{}", { status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  // 2xx 首次即成功
  const ok = makeFetch([200]);
  assert.deepEqual(await postWebhookWithRetry("https://x", {}, ok.fetchImpl), { ok: true, status: 200 });
  assert.equal(ok.calls.length, 1);

  // 4xx 不重试
  const clientError = makeFetch([404]);
  assert.deepEqual(await postWebhookWithRetry("https://x", {}, clientError.fetchImpl), {
    ok: false,
    status: 404,
  });
  assert.equal(clientError.calls.length, 1);

  // 5xx 重试至 3 次
  const serverError = makeFetch([500, 502, 503]);
  const result = await postWebhookWithRetry("https://x", {}, serverError.fetchImpl, [0, 0, 0]);
  assert.deepEqual(result, { ok: false, status: 503 });
  assert.equal(serverError.calls.length, 3);

  // 网络错重试后成功
  const flaky = makeFetch([0, 204]);
  assert.deepEqual(await postWebhookWithRetry("https://x", {}, flaky.fetchImpl, [0, 0]), {
    ok: true,
    status: 204,
  });
  assert.equal(flaky.calls.length, 2);
});

test("webhook 出站：载荷形态 + x-zcode-bot-secret 出站头（官方 send/test）", async () => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const provider = createWebhookBotProvider({
    fetchImpl,
    now: () => 42,
    credentialLoader: async () => "s3cret",
  });
  const secretBot: BotConfig = { ...webhookBot, webhookSecretRef: "bot:w1:webhook-secret" };

  await provider.send(secretBot, {
    botId: "w1",
    provider: "webhook",
    providerUserId: "u1",
    text: "hello",
  });
  assert.equal(JSON.parse(JSON.stringify(calls[0]?.body)).type, "zcode.bot.message");
  // 官方 send：`r&&(o[webhookAuthHeaderName||"x-zcode-bot-secret"]=r)`——出站头带密
  assert.equal(calls[0]?.headers[WEBHOOK_SECRET_HEADER_NAME], "s3cret");

  await provider.send(secretBot, {
    botId: "w1",
    provider: "webhook",
    providerUserId: "u1",
    text: "form",
    elicitation: {
      requestId: "r1",
      taskId: "t1",
      runId: "run1",
      currentQuestionIndex: 0,
      questions: [{ question: "q", header: "q", options: [] }],
      answers: {},
      status: "pending",
    },
  });
  assert.equal(JSON.parse(JSON.stringify(calls[1]?.body)).type, "zcode.bot.elicitation_request");

  const testResult = await provider.test(secretBot, "s3cret");
  assert.ok(testResult.ok);
  assert.equal(JSON.parse(JSON.stringify(calls[2]?.body)).type, "zcode.bot.test");
  // 官方 test：鉴权头恒带（无密为空串）
  assert.equal(calls[2]?.headers[WEBHOOK_SECRET_HEADER_NAME], "s3cret");

  // buildSelectionText：正文 + N. label - desc + 选项命令
  const text = buildWebhookSelectionText(
    {
      botId: "w1",
      provider: "webhook",
      providerUserId: "u1",
      text: "title",
      selection: {
        id: "workspace-1",
        title: "选择 workspace",
        action: "workspace.set",
        options: [{ id: "/workspace ws-1", label: "ws-1", description: "desc" }],
        showCancel: false,
      },
    },
    "zh-CN",
  );
  assert.ok(text.includes("选择 workspace"));
  assert.ok(text.includes("1. ws-1 - desc"));
  assert.ok(text.includes("/workspace ws-1"));
  assert.ok(!text.includes("0. "));
  // 无 selection 时原样 text
  assert.equal(
    buildWebhookSelectionText({ botId: "w1", provider: "webhook", providerUserId: "u1", text: "raw" }),
    "raw",
  );
  assert.equal(parseWebhookInbound(undefined).ok, false);
});
