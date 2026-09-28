// FreeCodeZ fork(Bots):withAuthorizedContext 授权链各拒绝分支 + R12 unknown 门禁 +
// "0"/数字待选拦截语义 + 消息建任务 happy path（附录B §1.3/§1.5/§6）。
// 运行: node --test packages/services/test/botsAuthChain.test.ts（经 tsx 加载源码）。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotConfig, BotContext, BotSelection, InboundMessage, OutboundMessage } from "@zcode/shared/bots";
import { BotInboundPipeline, type BotInboundPipelineDeps } from "../src/bots/inboundPipeline.js";
import { BotsRepo } from "../src/bots/botsRepo.js";
import { BindCodeStore } from "../src/bots/bindCodes.js";
import { BotResourceRegistry } from "../src/bots/resourceRegistry.js";
import { BotTaskBridge } from "../src/bots/taskBridge.js";
import type { BotTaskServiceLike } from "../src/bots/taskServiceLike.js";
import type { BotTaskStreamEvent } from "../src/bots/taskServiceLike.js";

const boundBot: BotConfig = {
  id: "bot-1",
  name: "bot",
  provider: "telegram",
  enabled: true,
  providerUserId: "owner",
  allowedWorkspaces: ["ws-1"],
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

const privateActor = {
  provider: "telegram" as const,
  botId: "bot-1",
  providerUserId: "owner",
  chatType: "private" as const,
  providerMessageId: "m-1",
};

let messageSeq = 0;
function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  messageSeq += 1;
  return {
    botId: "bot-1",
    text: "/help",
    // 每条消息独立 providerMessageId，避免撞上 2min 去重
    actor: { ...privateActor, providerMessageId: `m-${messageSeq}` },
    ...overrides,
  };
}

interface FakeTaskServiceState {
  created: Array<{ taskId: string; mode?: string }>;
  prompts: Array<{ taskId: string; content: string }>;
  modes: Array<{ taskId: string; mode: string }>;
}

function makeFakeTaskService(): { service: BotTaskServiceLike; state: FakeTaskServiceState } {
  const state: FakeTaskServiceState = { created: [], prompts: [], modes: [] };
  let taskSeq = 0;
  const service = {
    async createTask(params: { workspacePath: string; mode?: string }) {
      taskSeq += 1;
      const taskId = `task-${taskSeq}`;
      state.created.push({ taskId, ...(params.mode ? { mode: params.mode } : {}) });
      return {
        taskId,
        traceId: `trace-${taskSeq}`,
        title: "t",
        workspacePath: params.workspacePath,
        createdAt: 1,
        updatedAt: 1,
        mode: "yolo" as const,
      };
    },
    async setMode(params: { taskId: string; mode: string }) {
      state.modes.push(params);
    },
    async sendPrompt(params: { taskId: string; content: string }) {
      state.prompts.push({ taskId: params.taskId, content: params.content });
    },
    async resumeTask() {
      return {};
    },
    async stopGeneration() {},
    async respondPermission() {
      return true;
    },
    async respondElicitation() {
      return true;
    },
    async setModel() {
      return [];
    },
    async setConfigOption() {
      return [];
    },
    async listTasks() {
      return [];
    },
    async listDeletedTaskIds() {
      return [];
    },
    async getTaskMeta() {
      return null;
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
      return (_handler: (event: BotTaskStreamEvent) => void) => ({ dispose() {} });
    },
  } as unknown as BotTaskServiceLike;
  return { service, state };
}

async function makePipeline(options: {
  findAuthorizedBot?: BotInboundPipelineDeps["findAuthorizedBot"];
  readContext?: BotInboundPipelineDeps["readContext"];
  context?: BotContext;
  bot?: BotConfig | null;
  remote?: { isConnected: () => Promise<boolean>; reconnect: () => Promise<{ ok: boolean }> };
}): Promise<{
  pipeline: BotInboundPipeline;
  repo: BotsRepo;
  sent: OutboundMessage[];
  state: FakeTaskServiceState;
  dispose: () => Promise<void>;
}> {
  const configDir = await mkdtemp(join(tmpdir(), "bots-auth-"));
  const repo = new BotsRepo({ configDir });
  const { service, state } = makeFakeTaskService();
  const sent: OutboundMessage[] = [];
  const resourceRegistry = new BotResourceRegistry();
  const taskBridge = new BotTaskBridge({
    taskService: service,
    repo,
    resourceRegistry,
    sendOutbound: async (_bot, outbound) => {
      sent.push(outbound);
    },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    now: () => 1000,
  });
  const context: BotContext =
    options.context ??
    ({
      botId: "bot-1",
      workspacePath: "/ws-1",
      workspaceId: "ws-1",
      mode: "draft",
      activeTaskId: null,
      draftOptions: { provider: "glm" },
      updatedAt: 1,
    } as BotContext);
  const deps: BotInboundPipelineDeps = {
    repo,
    bindCodes: new BindCodeStore(),
    taskBridge,
    sendOutbound: async (_bot, outbound) => {
      sent.push(outbound);
    },
    listWorkspaceRefs: async () => [
      { id: "ws-1", label: "ws-1", workspacePath: "/ws-1" },
      { id: "ws-2", label: "ws-2", workspacePath: "/ws-2" },
    ],
    listModelCatalog: async () => [
      { id: "glm", name: "GLM", models: [{ id: "glm-5", name: "GLM-5", thoughtLevels: ["high"] }] },
    ],
    resolveModelSelection: async () => ({
      effectiveSelection: { providerId: "glm", modelId: "glm-5" },
      preferredSelection: { providerId: "glm", modelId: "glm-5" },
    }),
    pendingSelections: new Map<string, BotSelection>(),
    now: () => 1000,
    writeDraftContext: async (current) => {
      const next: BotContext = {
        ...current,
        mode: "draft",
        activeTaskId: null,
        draftOptions: { provider: "glm" },
        pendingPermissionOptions: undefined,
        pendingElicitation: undefined,
        updatedAt: 1000,
      };
      return next;
    },
    writeContext: async (current) => ({ ...current, updatedAt: 1000 }),
    saveBotConfig: async (bot) => bot,
    resolveLocale: async () => "zh-CN",
    findAuthorizedBot: options.findAuthorizedBot ?? (async () => options.bot === undefined ? boundBot : options.bot),
    readContext: options.readContext ?? (async () => context),
    ...(options.remote ? { remoteWorkspaceService: options.remote } : {}),
    attachments: { configDir, fetchImpl: fetch },
  };
  const pipeline = new BotInboundPipeline(deps);
  return {
    pipeline,
    repo,
    sent,
    state,
    dispose: () => rm(configDir, { recursive: true, force: true }),
  };
}

test("授权链：botDisabled → privateChatOnly → userNotBound → commandNotAllowed 逐命令回话", async () => {
  {
    const { pipeline, dispose } = await makePipeline({ bot: null });
    const replies = await pipeline.handleInboundMessage(makeMessage());
    assert.equal(replies[0]?.text, "当前 bot 未启用。");
    await dispose();
  }
  {
    const { pipeline, dispose } = await makePipeline({});
    const replies = await pipeline.handleInboundMessage(
      makeMessage({ actor: { ...privateActor, chatType: "group", chatId: "g-1" } }),
    );
    // 拒绝逐命令回话到 chatId ?? providerUserId
    assert.equal(replies[0]?.text, "Bots 暂不支持群聊，请在私聊中使用。");
    assert.equal(replies[0]?.providerUserId, "g-1");
    await dispose();
  }
  {
    // userNotBound：防御性分支（findAuthorizedBot 命中但 providerUserId 不匹配）
    const { pipeline, dispose } = await makePipeline({
      findAuthorizedBot: async () => boundBot,
      bot: boundBot,
    });
    const replies = await pipeline.handleInboundMessage(
      makeMessage({ actor: { ...privateActor, providerUserId: "stranger" } }),
    );
    assert.equal(replies[0]?.text, "当前 bot 未绑定。请先在 zcode UI 生成绑定码，然后发送 **/bind <code>**。");
    await dispose();
  }
  {
    const disabledPolicy: BotConfig = {
      ...boundBot,
      allowedCommands: { ...boundBot.allowedCommands, status: false },
    };
    const { pipeline, dispose } = await makePipeline({
      findAuthorizedBot: async () => disabledPolicy,
      bot: disabledPolicy,
    });
    const replies = await pipeline.handleInboundMessage(makeMessage({ text: "/status" }));
    assert.equal(replies[0]?.text, "当前 bot 未启用这个命令。");
    // help/message/approve/task/stop 恒允许
    const help = await pipeline.handleInboundMessage(makeMessage({ text: "/help" }));
    assert.ok(help[0]?.text.startsWith("FreeCodeZ 机器人命令："));
    await dispose();
  }
});

test("授权链：noWorkspaceAllowed → workspaceOutOfScope → 远端未连接（remoteDisconnected）", async () => {
  {
    const { pipeline, dispose } = await makePipeline({ readContext: async () => null });
    const replies = await pipeline.handleInboundMessage(makeMessage({ text: "/help" }));
    assert.equal(replies[0]?.text, "没有可用 workspace，请先在 Bots 设置里允许 workspace。");
    await dispose();
  }
  {
    const outOfScope: BotContext = {
      botId: "bot-1",
      workspacePath: "/ws-9",
      workspaceId: "ws-9",
      mode: "draft",
      activeTaskId: null,
      updatedAt: 1,
    };
    const { pipeline, dispose } = await makePipeline({ context: outOfScope });
    const replies = await pipeline.handleInboundMessage(makeMessage({ text: "/help" }));
    assert.equal(
      replies[0]?.text,
      "当前聊天上下文的 workspace 已不在授权范围内，请重新选择 **/项目**。",
    );
    await dispose();
  }
  {
    const remoteContext: BotContext = {
      botId: "bot-1",
      workspacePath: "/remote",
      workspaceIdentity: "ssh://host/remote",
      workspaceId: "ws-1",
      mode: "draft",
      activeTaskId: null,
      updatedAt: 1,
    };
    const { pipeline, dispose } = await makePipeline({
      context: remoteContext,
      remote: {
        isConnected: async () => false,
        reconnect: async () => ({ ok: true }),
      },
    });
    // message 走远端拦截 → remoteDisconnected
    const replies = await pipeline.handleInboundMessage(makeMessage({ text: "do something" }));
    assert.ok(replies[0]?.text.includes("未连接"));
    assert.ok(replies[0]?.text.includes("/remote"));
    // 豁免命令（help/status/workspace/reconnect/reply）不受远端拦截
    const help = await pipeline.handleInboundMessage(makeMessage({ text: "/help" }));
    assert.ok(help[0]?.text.startsWith("FreeCodeZ 机器人命令："));
    await dispose();
  }
});

test("R12：unknown 命令补门禁——群聊不回话；私聊回 unknownCommand", async () => {
  const { pipeline, dispose } = await makePipeline({});
  const inGroup = await pipeline.handleInboundMessage(
    makeMessage({ text: "/whatever", actor: { ...privateActor, chatType: "group", chatId: "g-1" } }),
  );
  assert.deepEqual(inGroup, []);
  const inPrivate = await pipeline.handleInboundMessage(makeMessage({ text: "/whatever" }));
  assert.equal(inPrivate[0]?.text, "未知命令：**/whatever**");
  // 门禁对 unknown 同样生效：禁用 bot 不回 unknownCommand
  const { pipeline: locked, dispose: dispose2 } = await makePipeline({ bot: null });
  const denied = await locked.handleInboundMessage(makeMessage({ text: "/whatever" }));
  assert.equal(denied[0]?.text, "当前 bot 未启用。");
  await dispose();
  await dispose2();
});

test("待选拦截：数字选项仅微信；非微信清 pending 后按原义；\"0\" 清 pending 后当消息", async () => {
  const { pipeline } = await makePipeline({});
  const selection: BotSelection = {
    id: "workspace-1",
    title: "选择 workspace",
    action: "workspace.set",
    options: [
      { id: "ws-1", label: "ws-1" },
      { id: "ws-2", label: "ws-2" },
    ],
  };

  // 微信 + 数字 → 映射回命令
  pipeline.pendingSelections.set("bot-1::weixin::wx-1", selection);
  const weixinResolved = pipeline.resolvePendingSelectionCommand(
    { ...privateActor, provider: "weixin", providerUserId: "wx-1" },
    "2",
  );
  assert.deepEqual(weixinResolved, { type: "workspace.set", value: "ws-2" });
  assert.equal(pipeline.pendingSelections.size, 0);

  // 微信 + 失配数字 → 清 pending 返回 null
  pipeline.pendingSelections.set("bot-1::weixin::wx-1", selection);
  assert.equal(
    pipeline.resolvePendingSelectionCommand(
      { ...privateActor, provider: "weixin", providerUserId: "wx-1" },
      "9",
    ),
    null,
  );
  assert.equal(pipeline.pendingSelections.size, 0);

  // 非微信 + 数字 → 清 pending 返回 null（数字也当 prompt）
  pipeline.pendingSelections.set("bot-1::telegram::owner", selection);
  assert.equal(pipeline.resolvePendingSelectionCommand(privateActor, "1"), null);
  assert.equal(pipeline.pendingSelections.size, 0);
});

test("消息建任务 happy path：强制 yolo + prompt_sent 广播 + sendPrompt（消息回发来自任务流）", async () => {
  const { pipeline, sent, state, dispose } = await makePipeline({});
  const message = makeMessage({ text: "fix the bug" });
  const replies = await pipeline.handleInboundMessage(message);
  // 成功路径无即时回话（由 watchTaskStream 回发）
  assert.deepEqual(replies, []);
  assert.equal(state.created.length, 1);
  assert.equal(state.created[0]?.taskId, "task-1");
  // 建任务后强制 yolo（§6.9 modeLocked）
  assert.deepEqual(state.modes, [{ taskId: "task-1", mode: "yolo" }]);
  assert.equal(state.prompts[0]?.content, "fix the bug");
  // 幂等：同一 providerMessageId 2min 去重
  const again = await pipeline.handleInboundMessage(message);
  assert.deepEqual(again, []);
  assert.equal(state.created.length, 1);
  void sent;
  await dispose();
});

test("bind：群聊 bindPrivateOnly 且不校验 code；无效 code → bindCodeInvalid", async () => {
  const { pipeline, dispose } = await makePipeline({});
  const inGroup = await pipeline.handleInboundMessage(
    makeMessage({
      text: "/bind WHATEV",
      actor: { ...privateActor, chatType: "group", chatId: "g-1", providerMessageId: "m-g" },
    }),
  );
  assert.equal(inGroup[0]?.text, "Bots 只允许在私聊中绑定。");
  const badCode = await pipeline.handleInboundMessage(
    makeMessage({ text: "/bind BAD000", actor: { ...privateActor, providerMessageId: "m-2" } }),
  );
  assert.equal(badCode[0]?.text, "绑定码无效或已过期，请在 zcode UI 重新生成。");
  await dispose();
});
