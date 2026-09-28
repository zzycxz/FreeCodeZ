// FreeCodeZ fork(Bots):飞书 transient 交互卡收口（官方 Mt @755240：PATCH 终态卡 + 注销登记，
// deleteTransientInteractionCard 仅定义无调用点）+ plan_approval 卡（§2.3）
// + ack 短路（飞书同步卡/已有 transient 卡无 elicitation 时跳过）+ 任务终态收口（tS task_complete/task_error）
// + R13 三路径释放登记表（deleteBot/停用/resetBotState 释放 transient 登记/typing/流订阅/pending）。
// 运行: node --import tsx --test packages/services/test/botsResourceRelease.test.ts。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BotConfig,
  BotProviderAdapter,
  ElicitationView,
  OutboundMessage,
} from "@zcode/shared/bots";
import type { ICredentialService } from "../src/credential/credential.js";
import {
  buildFeishuElicitationCard,
  createFeishuBotProvider,
  isFeishuSynchronousCardAction,
  readFeishuCardUpdateToken,
} from "../src/bots/providers/feishuProvider.js";
import { getPendingElicitationSelectionToken } from "../src/bots/elicitation.js";
import { BotResourceRegistry } from "../src/bots/resourceRegistry.js";
import { BotsRepo } from "../src/bots/botsRepo.js";
import { createBotsService } from "../src/bots/botsService.js";
import type { IBotsService } from "../src/bots/bots.js";
import type { BotTaskServiceLike, BotTaskStreamEvent } from "../src/bots/taskServiceLike.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const feishuBot: BotConfig = {
  id: "fs-1",
  name: "fs",
  provider: "feishu",
  enabled: true,
  credentialRef: "bot:fs-1:credential",
  feishuAppId: "cli_0123456789abcdef",
  providerUserId: "ou_user",
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
  replyMode: "streaming_card",
};

const elicitationOutbound: OutboundMessage = {
  botId: "fs-1",
  provider: "feishu",
  providerUserId: "ou_user",
  text: "选一个",
  elicitation: {
    requestId: "req-1",
    taskId: "task-1",
    runId: "run-1",
    currentQuestionIndex: 0,
    questions: [
      {
        question: "选一个",
        header: "选一个",
        options: [{ value: "a", label: "A" }],
      },
    ],
    answers: {},
    status: "pending",
  },
};

function makeFeishuFetchRecorder(): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; method: string; body: unknown }>;
} {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const payload = url.includes("tenant_access_token")
      ? { code: 0, tenant_access_token: "t-1", expire: 5400 }
      : url.includes("/im/v1/messages") && (init?.method ?? "GET") === "POST"
        ? { code: 0, data: { message_id: "om_1" } }
        : { code: 0, data: {} };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("transient POST/PATCH/DELETE：DELETE 仅定义（官方 Rde 无调用点，收口不走撤回）", async () => {
  const { fetchImpl, calls } = makeFeishuFetchRecorder();
  const provider = createFeishuBotProvider({
    fetchImpl,
    credentialLoader: async () => "app-secret",
  });
  const handle = await provider.createTransientInteractionCard?.(feishuBot, elicitationOutbound);
  assert.deepEqual(handle, { providerMessageId: "om_1" });
  const create = calls.at(-1);
  assert.ok(create);
  assert.equal(create.method, "POST");
  assert.ok(create.url.includes("/open-apis/im/v1/messages?receive_id_type=open_id"), create.url);
  assert.equal((create.body as { receive_id: string }).receive_id, "ou_user");

  await provider.updateTransientInteractionCard?.(feishuBot, handle!, elicitationOutbound);
  const update = calls.at(-1);
  assert.ok(update);
  assert.equal(update.method, "PATCH");
  assert.ok(update.url.includes("/open-apis/im/v1/messages/om_1"), update.url);
  assert.equal((update.body as { msg_type: string }).msg_type, "interactive");

  await provider.deleteTransientInteractionCard?.(feishuBot, handle!);
  const remove = calls.at(-1);
  assert.ok(remove);
  assert.equal(remove.method, "DELETE");
  assert.ok(remove.url.includes("/open-apis/im/v1/messages/om_1"), remove.url);
});

test("plan_approval 卡：plan markdown + --- + 标题 + 批准按钮（§2.3）", () => {
  const pending = {
    taskId: "task-1",
    requestId: "req-1",
    runId: "run-1",
    currentQuestionIndex: 0,
  };
  const token = getPendingElicitationSelectionToken(pending);
  const view: ElicitationView = {
    requestId: "req-1",
    taskId: "task-1",
    runId: "run-1",
    currentQuestionIndex: 0,
    questions: [
      {
        question: "请审阅此实施计划。",
        header: "实施计划",
        options: [
          {
            value: "approve",
            label: "批准",
            description: "退出计划模式并开始实施。",
          },
        ],
      },
    ],
    answers: {},
    status: "pending",
    schema: { interaction: "plan_approval", plan: "# 计划\n先改 A，再改 B" },
  };
  const card = buildFeishuElicitationCard(view, "zh-CN") as {
    body: { elements: Array<Record<string, unknown>> };
  };
  const elements = card.body.elements;
  const markdown = elements.find((element) => element.tag === "markdown");
  const content = String(markdown?.content ?? "");
  assert.ok(content.includes("# 计划"), content);
  assert.ok(content.includes("---"), content);
  assert.ok(content.includes("请审阅此实施计划。"), content);
  // 批准按钮（command 回放为 /elicitation <token> approve）
  const approve = elements.find((element) => {
    const behaviors = element.behaviors as Array<{ value?: { command?: string } }> | undefined;
    return behaviors?.[0]?.value?.command === `/elicitation ${token} approve`;
  });
  assert.ok(approve, "缺少批准按钮");
  assert.match(String((approve.text as { content: string }).content), /批准/u);
  // §2.4 表单形态：自定义按钮 + multiline_text form
  assert.ok(elements.some((element) => element.tag === "form"));
});

test("ack 短路判定：飞书同步卡识别 + card token 多键提取 + 无 token 不回执", async () => {
  assert.equal(isFeishuSynchronousCardAction({ action: { value: { command: "/help" } } }), true);
  assert.equal(isFeishuSynchronousCardAction({ zcodeFeishuSynchronousCardAction: true }), true);
  assert.equal(isFeishuSynchronousCardAction({ event: { action: { value: {} } } }), true);
  assert.equal(isFeishuSynchronousCardAction({ event: { message: {} } }), false);
  assert.equal(readFeishuCardUpdateToken({ token: "tk" }), "tk");
  assert.equal(readFeishuCardUpdateToken({ action: { card_update_token: "tk2" } }), "tk2");
  assert.equal(readFeishuCardUpdateToken({}), "");

  const { fetchImpl, calls } = makeFeishuFetchRecorder();
  const provider = createFeishuBotProvider({
    fetchImpl,
    credentialLoader: async () => "app-secret",
  });
  const before = calls.length;
  const result = await provider.acknowledgeCallback?.(
    feishuBot,
    { event: { message: {} } },
    "已收到。",
    undefined,
  );
  assert.equal(result, undefined);
  assert.equal(calls.length, before, "无 card token 时跳过卡片回执");
});

// ── R13 三路径释放（deleteBot / 停用 / resetBotState）集成 ──

interface Harness {
  service: IBotsService;
  calls: {
    created: number;
    updated: number;
    deleted: number;
    updatePayloads: OutboundMessage[];
    sent: OutboundMessage[];
    acked: number;
    unsubscribed: number;
  };
  emit: (event: BotTaskStreamEvent) => void;
  configDir: string;
}

async function makeHarness(): Promise<Harness> {
  const configDir = await mkdtemp(join(tmpdir(), "bots-release-"));
  const calls = {
    created: 0,
    updated: 0,
    deleted: 0,
    updatePayloads: [] as OutboundMessage[],
    sent: [] as OutboundMessage[],
    acked: 0,
    unsubscribed: 0,
  };
  let emit: ((event: BotTaskStreamEvent) => void) | undefined;
  const fakeFeishu: BotProviderAdapter = {
    provider: "feishu",
    async send(_bot, outbound) {
      calls.sent.push(outbound);
    },
    async test() {
      return { ok: true, message: "ok", provider: "feishu" };
    },
    async parseCallback(_bot, payload) {
      const text = (payload as { text?: string }).text ?? "/help";
      const messageId = (payload as { messageId?: string }).messageId ?? "m-x";
      return {
        ok: true,
        messages: [
          {
            botId: "fs-1",
            text,
            actor: {
              provider: "feishu",
              botId: "fs-1",
              providerUserId: "ou_user",
              chatType: "private",
              providerMessageId: messageId,
            },
          },
        ],
      };
    },
    async createTransientInteractionCard() {
      calls.created += 1;
      return { providerMessageId: `om-${calls.created}` };
    },
    async updateTransientInteractionCard(_bot, _handle, outbound) {
      calls.updated += 1;
      calls.updatePayloads.push(outbound);
    },
    async deleteTransientInteractionCard() {
      calls.deleted += 1;
    },
    async acknowledgeCallback() {
      calls.acked += 1;
      return { handled: true };
    },
  };
  const taskService = {
    async getTaskMeta() {
      return {
        taskId: "task-1",
        traceId: "trace-1",
        title: "t",
        workspacePath: "/w",
        createdAt: 1,
        updatedAt: 1,
        mode: "yolo",
      };
    },
    async respondPermission() {
      return true;
    },
    async respondElicitation() {
      return true;
    },
    async stopGeneration() {},
    async listTasks() {
      return [];
    },
    async listDeletedTaskIds() {
      return [];
    },
    async getTaskSnapshot() {
      return null;
    },
    async getTaskModelSelection() {
      return null;
    },
    async getTaskConfigOptions() {
      return [];
    },
    async deleteTask() {},
    onDynamicTaskEvent() {
      return (_handler: (event: BotTaskStreamEvent) => void) => {
        emit = _handler;
        return {
          dispose() {
            calls.unsubscribed += 1;
          },
        };
      };
    },
  } as unknown as BotTaskServiceLike;
  const credentialService = {
    async load() {
      return "app-secret";
    },
    async save() {},
    async delete() {},
  } as unknown as ICredentialService;
  const service = createBotsService({
    configDir,
    credentialService,
    taskService,
    adapters: [fakeFeishu],
    runStartupBackgroundTasks: false,
    createRuntimes: () => [],
    listWorkspaceRefs: async () => [{ id: "ws-1", label: "ws-1", workspacePath: "/w" }],
  });
  // 预置任务上下文（activeTaskId=task-1），/approve 才能命中 pendingPermissionOptions
  await new BotsRepo({ configDir }).updateState((state) => ({
    ...state,
    bots: {
      ...state.bots,
      "fs-1": {
        botId: "fs-1",
        workspacePath: "/w",
        workspaceId: "ws-1",
        mode: "task",
        activeTaskId: "task-1",
        updatedAt: 1,
      },
    },
  }));
  await service.saveConfig({ version: 3, bots: [feishuBot] });
  await service.watchAutomationRun({
    target: {
      provider: "feishu",
      botId: "fs-1",
      providerUserId: "ou_user",
      chatType: "private",
    },
    taskId: "task-1",
    workspacePath: "/w",
  });
  return {
    service,
    calls,
    emit: (event) => emit?.(event),
    configDir,
  };
}

const permissionRequest: BotTaskStreamEvent = {
  type: "permission_request",
  taskId: "task-1",
  traceId: "trace-1",
  requestId: "req-1",
  description: "run ls",
  kind: "bash",
  title: "Bash",
  options: [
    {
      optionId: "allow-once",
      kind: "allow",
      name: "Allow",
      description: "仅允许这一次",
      response: { decision: "approve" },
    },
    {
      optionId: "reject-once",
      kind: "deny",
      name: "Deny",
      response: { decision: "deny" },
    },
  ],
  raw: { command: "ls" },
} as unknown as BotTaskStreamEvent;

const elicitationRequest: BotTaskStreamEvent = {
  type: "elicitation_request",
  taskId: "task-1",
  traceId: "run-1",
  requestId: "req-2",
  message: "选一个",
  header: "选一个",
  options: [{ value: "a", label: "A" }],
  questions: [
    {
      question: "选一个",
      header: "选一个",
      options: [{ value: "a", label: "A" }],
    },
  ],
} as unknown as BotTaskStreamEvent;

async function primeInteraction(harness: Harness, order: "elicitation-first" | "permission-first"): Promise<void> {
  const first = order === "elicitation-first" ? elicitationRequest : permissionRequest;
  const second = order === "elicitation-first" ? permissionRequest : elicitationRequest;
  harness.emit(first);
  await sleep(80);
  assert.equal(harness.calls.created, 1, "首个交互卡 POST 创建 transient 卡");
  harness.emit(second);
  await sleep(80);
  assert.ok(harness.calls.updated >= 1, "第二个交互态走 PATCH 更新");
}

test("ack 短路：飞书同步卡跳过 acknowledgeCallback；普通载荷回执", async () => {
  const harness = await makeHarness();
  try {
    await harness.service.handleProviderCallback("feishu", {
      action: { value: { command: "/help" } },
      messageId: "m-sync-1",
    });
    await sleep(50);
    assert.equal(harness.calls.acked, 0, "飞书同步卡（card.action.trigger）跳过 ack");
    await harness.service.handleProviderCallback("feishu", {
      text: "/help",
      messageId: "m-plain-1",
    });
    await sleep(50);
    assert.equal(harness.calls.acked, 1, "普通载荷执行 acknowledgeCallback");
  } finally {
    await rm(harness.configDir, { recursive: true, force: true });
  }
});

test("PATCH 终态收口（Mt）：/approve 收口 = PATCH 终态卡 + 注销；零 DELETE、不另发文本", async () => {
  const harness = await makeHarness();
  try {
    // elicitation 先建卡、permission 后 PATCH（保全 pendingPermissionOptions 供 /approve 命中）
    await primeInteraction(harness, "elicitation-first");
    const ackedBefore = harness.calls.acked;
    const updatedBefore = harness.calls.updated;
    await harness.service.handleProviderCallback("feishu", {
      text: "/approve req-1 allow-once",
      messageId: "m-approve-1",
    });
    await sleep(50);
    assert.equal(harness.calls.acked, ackedBefore, "已有 transient 卡且无 elicitation → 跳过 ack");
    // 官方 Mt：收口回执原样作 PATCH 终态卡载荷，不撤回、不另发普通消息
    assert.equal(harness.calls.updated, updatedBefore + 1, "收口走 PATCH 终态卡");
    const finalCard = harness.calls.updatePayloads.at(-1);
    assert.ok(finalCard?.text.includes("已提交权限响应"), finalCard?.text);
    assert.equal(harness.calls.deleted, 0, "官方 deleteTransientInteractionCard 零调用点：收口不撤回");
    assert.ok(
      !harness.calls.sent.some((outbound) => outbound.text.includes("已提交权限响应")),
      "文本回执即 PATCH 载荷，不另发普通消息",
    );
    // 注销登记生效：重复 /approve 不再 PATCH
    await harness.service.handleProviderCallback("feishu", {
      text: "/approve req-1 allow-once",
      messageId: "m-approve-2",
    });
    await sleep(50);
    assert.equal(harness.calls.updated, updatedBefore + 1, "收口已注销登记，不再 PATCH");
  } finally {
    await rm(harness.configDir, { recursive: true, force: true });
  }
});

test("任务终态收口（tS Mt）：task_complete → PATCH `已收到。`；task_error → `任务失败：`；注销后不重复", async () => {
  const harness = await makeHarness();
  try {
    harness.emit(permissionRequest);
    await sleep(80);
    assert.equal(harness.calls.created, 1, "权限卡 POST 创建 transient 卡");
    harness.emit({ type: "task_complete", taskId: "task-1" } as unknown as BotTaskStreamEvent);
    await sleep(80);
    assert.equal(harness.calls.deleted, 0, "终态收口不撤回卡");
    assert.equal(harness.calls.updatePayloads.at(-1)?.text, "已收到。");
    // 注销后再次终态不重复 PATCH
    harness.emit({ type: "task_complete", taskId: "task-1" } as unknown as BotTaskStreamEvent);
    await sleep(80);
    assert.equal(harness.calls.updated, 1, "注销登记后不再 PATCH");
  } finally {
    await rm(harness.configDir, { recursive: true, force: true });
  }

  const failing = await makeHarness();
  try {
    failing.emit(permissionRequest);
    await sleep(80);
    failing.emit({
      type: "task_error",
      taskId: "task-1",
      error: "boom",
    } as unknown as BotTaskStreamEvent);
    await sleep(80);
    assert.equal(failing.calls.updatePayloads.at(-1)?.text, "任务失败：boom");
  } finally {
    await rm(failing.configDir, { recursive: true, force: true });
  }
});

test("任务终态收口：pending elicitation → 取消问答卡（eS cancel）+ 清 pending 状态", async () => {
  const harness = await makeHarness();
  try {
    harness.emit(elicitationRequest);
    await sleep(80);
    assert.equal(harness.calls.created, 1);
    const before = await harness.service.getBotStates();
    assert.ok(
      before.find((entry) => entry.botId === "fs-1")?.pendingElicitation,
      "pending elicitation 已登记",
    );
    harness.emit({ type: "task_complete", taskId: "task-1" } as unknown as BotTaskStreamEvent);
    await sleep(80);
    const payload = harness.calls.updatePayloads.at(-1);
    assert.equal(payload?.text, "已取消问答请求。", "eS cancel 载荷文本");
    assert.equal(payload?.elicitation?.status, "cancelled", "取消问答卡 status=cancelled");
    assert.equal(harness.calls.deleted, 0);
    const after = await harness.service.getBotStates();
    assert.equal(
      after.find((entry) => entry.botId === "fs-1")?.pendingElicitation,
      undefined,
      "终态清 pending elicitation",
    );
  } finally {
    await rm(harness.configDir, { recursive: true, force: true });
  }
});

test("R13 三路径释放：deleteBot / 停用 / resetBotState 只注销登记（零 DELETE）+ 流订阅 + typing", async () => {
  for (const path of ["deleteBot", "disable", "resetBotState"] as const) {
    const harness = await makeHarness();
    try {
      // permission 先建卡、elicitation 后 PATCH 并登记 pending elicitation
      await primeInteraction(harness, "permission-first");
      const statesBefore = await harness.service.getBotStates();
      assert.ok(
        statesBefore.find((entry) => entry.botId === "fs-1")?.pendingElicitation,
        "pending elicitation 已登记",
      );
      const updatedBefore = harness.calls.updated;
      if (path === "deleteBot") {
        await harness.service.deleteBot({ botId: "fs-1" });
      } else if (path === "disable") {
        await harness.service.saveConfig({
          version: 3,
          bots: [{ ...feishuBot, enabled: false }],
        });
      } else {
        await harness.service.resetBotState({ botId: "fs-1" });
      }
      await sleep(80);
      // 官方 deleteTransientInteractionCard 全构建零调用点：释放路径只注销登记，不撤回卡
      assert.equal(harness.calls.deleted, 0, `${path}：零 DELETE（官方无调用点）`);
      assert.equal(harness.calls.unsubscribed, 1, `${path}：任务流订阅退订`);
      assert.equal(harness.calls.created, 1, `${path}：释放后无外发残留`);
      // 注销登记生效：释放后任务终态不再 PATCH 收口
      harness.emit({ type: "task_complete", taskId: "task-1" } as unknown as BotTaskStreamEvent);
      await sleep(80);
      assert.equal(harness.calls.updated, updatedBefore, `${path}：登记已注销，终态不再 PATCH`);
      if (path === "disable") {
        // pending elicitation 由登记 dispose 清理
        const states = await harness.service.getBotStates();
        const state = states.find((entry) => entry.botId === "fs-1");
        assert.equal(state?.pendingElicitation, undefined, "停用：pending elicitation 已清");
      }
      if (path === "resetBotState") {
        const states = await harness.service.getBotStates();
        assert.equal(
          states.find((entry) => entry.botId === "fs-1"),
          undefined,
          "resetBotState：状态已清",
        );
      }
    } finally {
      await rm(harness.configDir, { recursive: true, force: true });
    }
  }
});

test("BotResourceRegistry scope 登记：替换自注销 + releaseScoped 触发 dispose", () => {
  const registry = new BotResourceRegistry();
  const disposed: string[] = [];
  registry.registerScoped("bot-1", "selection:a", {
    dispose: () => {
      disposed.push("old");
    },
  });
  registry.registerScoped("bot-1", "selection:a", {
    dispose: () => {
      disposed.push("new");
    },
  });
  assert.deepEqual(disposed, ["old"], "同 scope 替换时旧句柄先释放");
  registry.releaseScoped("bot-1", "selection:a");
  assert.deepEqual(disposed, ["old", "new"]);
  // 幂等：重复 releaseScoped 无副作用
  registry.releaseScoped("bot-1", "selection:a");
  assert.deepEqual(disposed, ["old", "new"]);
  // bot 级三路径释放覆盖 scope 登记
  registry.registerScoped("bot-1", "elicitation:r", {
    dispose: () => {
      disposed.push("elicitation");
    },
  });
  registry.releaseBotResources("bot-1");
  assert.deepEqual(disposed, ["old", "new", "elicitation"]);
  assert.equal(registry.size, 0);
});
