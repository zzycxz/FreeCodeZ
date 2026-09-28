// FreeCodeZ fork(Bots):RemoteWorkspaceGate 真实注入后的纯逻辑语义（附录D §3.2-1/附录B §6-4/§6-10）：
// ①远端拦截三文案由 gate 的 isConnected 真实判定（不再恒视为未连接）；
// ②/reconnect 文案全集（local/unavailable/alreadyConnected/starting/failed）+ 3s 冷却 + 2min 独立去重；
// ③gate.reconnect 超时/失败 → remoteReconnectFailed{message}。
// 运行: node --test packages/services/test/botsRemoteGate.test.ts（经 tsx 加载源码）。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BotConfig,
  BotContext,
  BotSelection,
  InboundMessage,
  OutboundMessage,
} from "@zcode/shared/bots";
import {
  BotInboundPipeline,
  type BotInboundPipelineDeps,
  type RemoteWorkspaceGate,
} from "../src/bots/inboundPipeline.js";
import { BotsRepo } from "../src/bots/botsRepo.js";
import { BindCodeStore } from "../src/bots/bindCodes.js";
import { BotResourceRegistry } from "../src/bots/resourceRegistry.js";
import { BotTaskBridge } from "../src/bots/taskBridge.js";
import type { BotTaskServiceLike, BotTaskStreamEvent } from "../src/bots/taskServiceLike.js";

const boundBot: BotConfig = {
  id: "bot-1",
  name: "bot",
  provider: "telegram",
  enabled: true,
  providerUserId: "owner",
  allowedWorkspaces: ["*"],
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

const localContext: BotContext = {
  botId: "bot-1",
  workspacePath: "/local",
  workspaceId: "ws-local",
  mode: "draft",
  activeTaskId: null,
  draftOptions: { provider: "glm" },
  updatedAt: 1,
} as BotContext;

const remoteContext: BotContext = {
  botId: "bot-1",
  workspacePath: "/remote",
  workspaceIdentity: "ssh://host/remote",
  workspaceId: "ws-remote",
  mode: "draft",
  activeTaskId: null,
  draftOptions: { provider: "glm" },
  updatedAt: 1,
} as BotContext;

const baseActor = {
  provider: "telegram" as const,
  botId: "bot-1",
  providerUserId: "owner",
  chatType: "private" as const,
};

let messageSeq = 0;
function makeMessage(
  overrides: Partial<InboundMessage> & { omitProviderMessageId?: boolean } = {},
): InboundMessage {
  messageSeq += 1;
  const { omitProviderMessageId, ...rest } = overrides;
  return {
    botId: "bot-1",
    text: "/help",
    actor: {
      ...baseActor,
      ...(omitProviderMessageId ? {} : { providerMessageId: `m-${messageSeq}` }),
    },
    ...rest,
  };
}

function makeFakeTaskService(): {
  service: BotTaskServiceLike;
  state: { created: Array<{ taskId: string }>; prompts: Array<{ content: string }> };
} {
  const state = { created: [], prompts: [] } as {
    created: Array<{ taskId: string }>;
    prompts: Array<{ content: string }>;
  };
  let taskSeq = 0;
  const service = {
    async createTask(params: { workspacePath: string; mode?: string }) {
      taskSeq += 1;
      state.created.push({ taskId: `task-${taskSeq}` });
      return {
        taskId: `task-${taskSeq}`,
        traceId: `trace-${taskSeq}`,
        title: "t",
        workspacePath: params.workspacePath,
        createdAt: 1,
        updatedAt: 1,
        mode: "yolo" as const,
      };
    },
    async setMode() {},
    async sendPrompt(params: { taskId: string; content: string }) {
      state.prompts.push({ content: params.content });
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

interface FakeGateControl {
  gate: RemoteWorkspaceGate;
  isConnectedCalls: number;
  reconnectCalls: number;
  setConnected: (value: boolean) => void;
}

function makeFakeGate(options: {
  connected?: boolean;
  onReconnect?: () => Promise<{ ok: boolean; message?: string }>;
}): FakeGateControl {
  let connected = options.connected ?? false;
  const control: FakeGateControl = {
    isConnectedCalls: 0,
    reconnectCalls: 0,
    setConnected: (value) => {
      connected = value;
    },
    gate: {
      async isConnected() {
        control.isConnectedCalls += 1;
        return connected;
      },
      async reconnect() {
        control.reconnectCalls += 1;
        if (options.onReconnect) {
          return options.onReconnect();
        }
        connected = true;
        return { ok: true };
      },
    },
  };
  return control;
}

async function makePipeline(options: {
  context?: BotContext;
  gate?: FakeGateControl | null;
  remoteWorkspaceService?: RemoteWorkspaceGate;
}): Promise<{
  pipeline: BotInboundPipeline;
  sent: OutboundMessage[];
  state: { created: Array<{ taskId: string }>; prompts: Array<{ content: string }> };
  clock: { now: number };
  dispose: () => Promise<void>;
}> {
  const configDir = await mkdtemp(join(tmpdir(), "bots-remote-gate-"));
  const repo = new BotsRepo({ configDir });
  const { service, state } = makeFakeTaskService();
  const sent: OutboundMessage[] = [];
  const clock = { now: 1_000 };
  const resourceRegistry = new BotResourceRegistry();
  const sendOutbound = async (_bot: BotConfig, outbound: OutboundMessage): Promise<void> => {
    sent.push(outbound);
  };
  const taskBridge = new BotTaskBridge({
    taskService: service,
    repo,
    resourceRegistry,
    sendOutbound,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    now: () => clock.now,
  });
  const context = options.context ?? localContext;
  const gate = options.gate ?? undefined;
  const remoteWorkspaceService =
    options.remoteWorkspaceService ?? (gate ? gate.gate : undefined);
  const deps: BotInboundPipelineDeps = {
    repo,
    bindCodes: new BindCodeStore(),
    taskBridge,
    sendOutbound,
    listWorkspaceRefs: async () => [
      { id: "ws-local", label: "本地项目", workspacePath: "/local" },
      {
        id: "ws-remote",
        label: "远端项目",
        workspacePath: "/remote",
        workspaceIdentity: "ssh://host/remote",
        remote: true,
      },
      {
        id: "ws-remote2",
        label: "远端项目2",
        workspacePath: "/remote2",
        workspaceIdentity: "ssh://host/remote2",
        remote: true,
      },
    ],
    listModelCatalog: async () => [
      { id: "glm", name: "GLM", models: [{ id: "glm-5", name: "GLM-5" }] },
    ],
    resolveModelSelection: async () => ({
      effectiveSelection: { providerId: "glm", modelId: "glm-5" },
      preferredSelection: { providerId: "glm", modelId: "glm-5" },
    }),
    pendingSelections: new Map<string, BotSelection>(),
    now: () => clock.now,
    writeDraftContext: async (current) => ({ ...current, updatedAt: clock.now }),
    writeContext: async (current) => ({ ...current, updatedAt: clock.now }),
    saveBotConfig: async (bot) => bot,
    resolveLocale: async () => "zh-CN",
    findAuthorizedBot: async () => boundBot,
    readContext: async () => context,
    ...(remoteWorkspaceService ? { remoteWorkspaceService } : {}),
    attachments: { configDir, fetchImpl: fetch },
    // 与 botsService 的装配同形：本地 workspace 视为已连接，远端按 gate 真实判定。
    isRemoteConnected: async (target) => {
      if (!target.workspaceIdentity) return true;
      return (
        (await remoteWorkspaceService?.isConnected({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
        })) ?? false
      );
    },
  };
  const pipeline = new BotInboundPipeline(deps);
  return {
    pipeline,
    sent,
    state,
    clock,
    dispose: () => rm(configDir, { recursive: true, force: true }),
  };
}

test("远端拦截：gate 未连接 → message remoteDisconnected；status remoteDisconnectedStatus；切未连接远端 remoteWorkspaceSelectedDisconnected", async () => {
  const gate = makeFakeGate({ connected: false });
  const { pipeline, dispose } = await makePipeline({ context: remoteContext, gate });
  try {
    // ①消息被拦截（授权链最后一级），文案提示先 /重连
    const blocked = await pipeline.handleInboundMessage(makeMessage({ text: "fix the bug" }));
    assert.equal(
      blocked[0]?.text,
      "当前远端项目 /remote 未连接。请先发送 **/重连**，连接恢复后再重试。上一条请求未执行。",
    );
    assert.ok(gate.isConnectedCalls >= 1);
    // ②status 豁免拦截，但状态文本带 remoteDisconnectedStatus
    const status = await pipeline.handleInboundMessage(makeMessage({ text: "/status" }));
    assert.ok(status[0]?.text.includes("请发送 **/重连** 恢复连接。"));
    // ③切到未连接远端：workspace.set 先写 draft，再回 remoteWorkspaceSelectedDisconnected
    const switched = await pipeline.handleInboundMessage(makeMessage({ text: "/项目 ws-remote2" }));
    assert.equal(
      switched[0]?.text,
      "已切换到远端项目 /remote2，但当前未连接。请先发送 **/重连** 后再执行任务。",
    );
  } finally {
    await dispose();
  }
});

test("远端拦截：gate 已连接放行——消息进任务链（不再恒视为未连接）", async () => {
  const gate = makeFakeGate({ connected: true });
  const { pipeline, state, dispose } = await makePipeline({ context: remoteContext, gate });
  try {
    const replies = await pipeline.handleInboundMessage(makeMessage({ text: "fix the bug" }));
    assert.deepEqual(replies, []);
    assert.equal(state.created.length, 1);
    assert.equal(state.prompts[0]?.content, "fix the bug");
  } finally {
    await dispose();
  }
});

test("/reconnect 文案：本地 remoteReconnectLocal；无服务 remoteReconnectUnavailable；已连接 remoteReconnectAlreadyConnected", async () => {
  {
    const { pipeline, dispose } = await makePipeline({ context: localContext, gate: null });
    const replies = await pipeline.handleInboundMessage(makeMessage({ text: "/reconnect" }));
    assert.equal(
      replies[0]?.text,
      "当前 workspace 是本地项目，不需要重连。发送 **/项目** 可切换远端项目。",
    );
    await dispose();
  }
  {
    const { pipeline, dispose } = await makePipeline({ context: remoteContext, gate: null });
    const replies = await pipeline.handleInboundMessage(makeMessage({ text: "/reconnect" }));
    assert.equal(
      replies[0]?.text,
      "当前远端项目 /remote 未连接，但机器人无法访问远端重连服务。请先在 FreeCodeZ 打开该远端项目后重试。",
    );
    await dispose();
  }
  {
    const gate = makeFakeGate({ connected: true });
    const { pipeline, dispose } = await makePipeline({ context: remoteContext, gate });
    const replies = await pipeline.handleInboundMessage(makeMessage({ text: "/reconnect" }));
    assert.equal(replies[0]?.text, "当前远端项目 /remote 已连接。");
    assert.equal(gate.reconnectCalls, 0);
    await dispose();
  }
});

test("/reconnect 成功：先回 remoteReconnectStarting，gate.reconnect 后回状态文本", async () => {
  const gate = makeFakeGate({ connected: false });
  const { pipeline, sent, dispose } = await makePipeline({ context: remoteContext, gate });
  try {
    const replies = await pipeline.handleInboundMessage(makeMessage({ text: "/重连" }));
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.text, "当前远端项目 /remote 未连接，正在为你重连...");
    assert.equal(gate.reconnectCalls, 1);
    // 成功后回状态文本（gate 切为已连接），不含失败/未连接文案
    assert.equal(replies.length, 1);
    assert.ok(replies[0]?.text.includes("远端项目"));
    assert.ok(!replies[0]?.text.includes("重连失败"));
    assert.ok(!replies[0]?.text.includes("未连接"));
  } finally {
    await dispose();
  }
});

test("/reconnect 失败/超时：gate 抛错或回 ok=false → remoteReconnectFailed{message}", async () => {
  {
    // 超时/异常（官方 ensureConnected 60s 超时同路径）
    const gate = makeFakeGate({
      connected: false,
      onReconnect: async () => {
        throw new Error("等待重连结果超时（60s）");
      },
    });
    const { pipeline, dispose } = await makePipeline({ context: remoteContext, gate });
    const replies = await pipeline.handleInboundMessage(makeMessage({ text: "/reconnect" }));
    assert.equal(
      replies[0]?.text,
      "当前远端项目 /remote 重连失败：等待重连结果超时（60s）\n上一条请求没有执行。",
    );
    await dispose();
  }
  {
    // 结构化失败带 message
    const gate = makeFakeGate({
      connected: false,
      onReconnect: async () => ({ ok: false, message: "boom" }),
    });
    const { pipeline, dispose } = await makePipeline({ context: remoteContext, gate });
    const replies = await pipeline.handleInboundMessage(makeMessage({ text: "/reconnect" }));
    assert.equal(
      replies[0]?.text,
      "当前远端项目 /remote 重连失败：boom\n上一条请求没有执行。",
    );
    await dispose();
  }
});

test("/reconnect 3s 冷却回 []；2min 独立去重回 []", async () => {
  const gate = makeFakeGate({ connected: false });
  const { pipeline, clock, dispose } = await makePipeline({ context: remoteContext, gate });
  try {
    // 无 providerMessageId 的重试消息绕过 2min 去重，直接命中 3s 冷却分支
    await pipeline.handleInboundMessage(makeMessage({ text: "/reconnect", omitProviderMessageId: true }));
    assert.equal(gate.reconnectCalls, 1);
    clock.now += 2_000;
    const cooled = await pipeline.handleInboundMessage(
      makeMessage({ text: "/reconnect", omitProviderMessageId: true }),
    );
    assert.deepEqual(cooled, []);
    assert.equal(gate.reconnectCalls, 1);
    // 冷却期外（≥3s）允许再次发起
    gate.setConnected(false);
    clock.now += 3_000;
    await pipeline.handleInboundMessage(makeMessage({ text: "/reconnect", omitProviderMessageId: true }));
    assert.equal(gate.reconnectCalls, 2);
  } finally {
    await dispose();
  }

  const dedupeGate = makeFakeGate({ connected: false });
  const second = await makePipeline({ context: remoteContext, gate: dedupeGate });
  try {
    // /reconnect 独立 2min 去重（key 不含 providerMessageId）：同 actor 2min 内重复 /reconnect 回 []
    await second.pipeline.handleInboundMessage(makeMessage({ text: "/reconnect" }));
    assert.equal(dedupeGate.reconnectCalls, 1);
    const repeated = await second.pipeline.handleInboundMessage(makeMessage({ text: "/reconnect" }));
    assert.deepEqual(repeated, []);
    assert.equal(dedupeGate.reconnectCalls, 1);
  } finally {
    await second.dispose();
  }
});
