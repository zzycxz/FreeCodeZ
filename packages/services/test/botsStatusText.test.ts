// FreeCodeZ fork(Bots):buildStatusText [已工作]/[进展] 两行（附录B §2.6）：
// 任务运行耗时天/时/分/秒按需出现、进展 180 截断、拿不到就不加该行（缺省省略）。
// 运行: node --import tsx --test packages/services/test/botsStatusText.test.ts。
import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeTaskMeta, ZCodeTaskSnapshot } from "@zcode/shared";
import type { BotActor, BotConfig, BotContext } from "@zcode/shared/bots";
import { buildStatusText, type BotCommandDeps } from "../src/bots/commandHandlers.js";
import {
  formatTaskRunningDuration,
  formatStatusStreamToolProgress,
  truncateLiveStatusProgressText,
} from "../src/bots/replyPipeline.js";
import { BotTaskBridge, readLatestTaskProgress } from "../src/bots/taskBridge.js";
import { BotsRepo } from "../src/bots/botsRepo.js";
import { BindCodeStore } from "../src/bots/bindCodes.js";
import { BotResourceRegistry } from "../src/bots/resourceRegistry.js";
import type { BotTaskServiceLike, BotTaskStreamEvent } from "../src/bots/taskServiceLike.js";

const bot: BotConfig = {
  id: "bot-1",
  name: "bot",
  provider: "telegram",
  enabled: true,
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

const actor: BotActor = {
  provider: "telegram",
  botId: "bot-1",
  providerUserId: "owner",
  chatType: "private",
};

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function makeStatusFixture(
  meta: ZCodeTaskMeta | null,
  snapshot?: ZCodeTaskSnapshot | null,
): {
  deps: BotCommandDeps;
  bridge: BotTaskBridge;
  setNow: (value: number) => void;
} {
  let nowMs = 1_000_000;
  const taskService = {
    async getTaskMeta() {
      return meta;
    },
    async getTaskSnapshot() {
      return snapshot ?? null;
    },
    onDynamicTaskEvent() {
      return (_handler: (event: BotTaskStreamEvent) => void) => ({ dispose() {} });
    },
  } as unknown as BotTaskServiceLike;
  const bridge = new BotTaskBridge({
    taskService,
    repo: new BotsRepo({ configDir: process.env.TEMP ?? process.env.TMPDIR ?? "." }),
    resourceRegistry: new BotResourceRegistry(),
    sendOutbound: async () => undefined,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    now: () => nowMs,
  });
  const deps = {
    repo: new BotsRepo({ configDir: process.env.TEMP ?? process.env.TMPDIR ?? "." }),
    bindCodes: new BindCodeStore(),
    taskBridge: bridge,
    sendOutbound: async () => undefined,
    listWorkspaceRefs: async () => [{ id: "ws-1", label: "ws-1", workspacePath: "/ws-1" }],
    listModelCatalog: async () => [],
    resolveModelSelection: async () => ({ effectiveSelection: null }),
    pendingSelections: new Map(),
    now: () => nowMs,
    writeDraftContext: async (current: BotContext) => current,
    writeContext: async (current: BotContext) => current,
    saveBotConfig: async (saved: BotConfig) => saved,
    resolveLocale: async () => "zh-CN",
  } as unknown as BotCommandDeps;
  return {
    deps,
    bridge,
    setNow: (value: number) => {
      nowMs = value;
    },
  };
}

function taskContext(activeTaskId = "task-1"): BotContext {
  return {
    botId: "bot-1",
    workspacePath: "/ws-1",
    workspaceId: "ws-1",
    mode: "task",
    activeTaskId,
    updatedAt: 1,
  };
}

async function renderStatus(
  fixture: ReturnType<typeof makeStatusFixture>,
  context: BotContext,
): Promise<string> {
  return buildStatusText({ deps: fixture.deps, bot, actor, context, locale: "zh-CN" });
}

test("formatTaskRunningDuration：天/时/分/秒按需出现（官方同款 1d 2h 3m 4s）", () => {
  assert.equal(
    formatTaskRunningDuration(DAY + 2 * HOUR + 3 * MINUTE + 4000),
    "1d 2h 3m 4s",
  );
  assert.equal(formatTaskRunningDuration(3 * MINUTE + 4000), "3m 4s");
  assert.equal(formatTaskRunningDuration(5000), "5s");
  assert.equal(formatTaskRunningDuration(0), "0s");
  assert.equal(formatTaskRunningDuration(-5), "0s");
});

test("状态文本：草稿缺省省略——无 [已工作]/[进展] 行", async () => {
  const fixture = makeStatusFixture(null);
  const text = await renderStatus(fixture, {
    botId: "bot-1",
    workspacePath: "/ws-1",
    workspaceId: "ws-1",
    mode: "draft",
    activeTaskId: null,
    updatedAt: 1,
  });
  assert.ok(text.includes("任务: 草稿"));
  assert.ok(!text.includes("已工作"), text);
  assert.ok(!text.includes("进展"), text);
});

test("状态文本：运行中含 [已工作: 1d 2h 3m 4s] 与 [进展]（任务流最新进展）", async () => {
  const startAt = 1_000_000;
  const meta = {
    taskId: "task-1",
    traceId: "trace-1",
    title: "修复登录",
    workspacePath: "/ws-1",
    createdAt: startAt,
    updatedAt: startAt,
    mode: "yolo",
    status: "running",
  } as unknown as ZCodeTaskMeta;
  const fixture = makeStatusFixture(meta);
  fixture.bridge.markTaskRunStarted("task-1");
  fixture.setNow(startAt + DAY + 2 * HOUR + 3 * MINUTE + 4000);
  fixture.bridge.updateLiveStatusProgress("task-1", {
    type: "agent_message_chunk",
    content: "正在   检查\n登录逻辑",
  } as unknown as BotTaskStreamEvent);
  const text = await renderStatus(fixture, taskContext());
  assert.ok(text.includes("任务: 修复登录 (task-1)"), text);
  assert.ok(text.includes("已工作: 1d 2h 3m 4s"), text);
  // normalizeInlineText：折叠空白后的最新进展
  assert.ok(text.includes("进展: 正在 检查 登录逻辑"), text);
  assert.ok(text.includes("状态: ⏳ 运行中"), text);
});

test("状态文本：[进展] 取最后工具行；实时登记原样显示（1000 尾窗在登记时截断，显示行不二次截断）", async () => {
  const meta = {
    taskId: "task-1",
    traceId: "trace-1",
    title: "t",
    workspacePath: "/ws-1",
    createdAt: 0,
    updatedAt: 0,
    mode: "yolo",
    status: "running",
  } as unknown as ZCodeTaskMeta;
  const fixture = makeStatusFixture(meta);
  // 无进展登记、无快照兜底 → 省略
  const empty = await renderStatus(fixture, taskContext());
  assert.ok(!empty.includes("进展"), empty);
  // 工具行覆盖消息进展（最后工具行语义）
  fixture.bridge.updateLiveStatusProgress("task-1", {
    type: "tool_call_update",
    title: "edit",
    status: "completed",
    input: { path: "/ws-1/a.ts" },
  } as unknown as BotTaskStreamEvent);
  const toolLine = await renderStatus(fixture, taskContext());
  assert.ok(toolLine.includes("进展: edit [completed]: /ws-1/a.ts"), toolLine);
  // 实时登记（QZ 尾窗 1000）显示行原样输出：300 字不截为 180（官方 eT 无显示截断，勘误见报告）
  fixture.bridge.updateLiveStatusProgress("task-1", {
    type: "agent_message_chunk",
    content: "x".repeat(300),
  } as unknown as BotTaskStreamEvent);
  const longText = await renderStatus(fixture, taskContext());
  const progressLine = longText.split("\n").find((line) => line.startsWith("进展: "));
  assert.ok(progressLine, longText);
  assert.equal(progressLine.slice("进展: ".length), "x".repeat(300));
  // 终态后进展清空（拿不到进展就不加该行）
  fixture.bridge.markTaskFinished("task-1");
  const afterTerminal = await renderStatus(fixture, taskContext());
  assert.ok(!afterTerminal.includes("进展"), afterTerminal);
});

const runningMeta = {
  taskId: "task-1",
  traceId: "trace-1",
  title: "修复登录",
  workspacePath: "/ws-1",
  createdAt: 1_000,
  updatedAt: 1_000,
  mode: "yolo",
  status: "running",
} as unknown as ZCodeTaskMeta;

function makeSnapshot(messages: unknown[]): ZCodeTaskSnapshot {
  return { meta: runningMeta, messages } as unknown as ZCodeTaskSnapshot;
}

test("状态文本：[进展] 仅运行中显示（官方 `!ce||ap(ce)===\"running\"`，ap=status??running）", async () => {
  // meta status=completed → 终态隐藏（即便实时登记仍在）
  const finished = makeStatusFixture(
    { ...runningMeta, status: "completed" } as unknown as ZCodeTaskMeta,
    makeSnapshot([]),
  );
  finished.bridge.markTaskRunStarted("task-1");
  finished.bridge.updateLiveStatusProgress("task-1", {
    type: "agent_message_chunk",
    content: "不该显示",
  } as unknown as BotTaskStreamEvent);
  const hidden = await renderStatus(finished, taskContext());
  assert.ok(!hidden.includes("进展"), hidden);

  // meta status=error → 同样隐藏
  const errored = makeStatusFixture(
    { ...runningMeta, status: "error" } as unknown as ZCodeTaskMeta,
    makeSnapshot([]),
  );
  errored.bridge.updateLiveStatusProgress("task-1", {
    type: "agent_message_chunk",
    content: "不该显示",
  } as unknown as BotTaskStreamEvent);
  assert.ok(!(await renderStatus(errored, taskContext())).includes("进展"));

  // meta 缺失 → 视为运行中，显示
  const noMeta = makeStatusFixture(null, makeSnapshot([]));
  noMeta.bridge.updateLiveStatusProgress("task-1", {
    type: "agent_message_chunk",
    content: "运行中进展",
  } as unknown as BotTaskStreamEvent);
  assert.ok((await renderStatus(noMeta, taskContext())).includes("进展: 运行中进展"));

  // meta.status 缺省（ap=running）→ 显示
  const statusless = makeStatusFixture(
    { ...runningMeta, status: undefined } as unknown as ZCodeTaskMeta,
    makeSnapshot([]),
  );
  statusless.bridge.updateLiveStatusProgress("task-1", {
    type: "agent_message_chunk",
    content: "缺省状态进展",
  } as unknown as BotTaskStreamEvent);
  assert.ok((await renderStatus(statusless, taskContext())).includes("进展: 缺省状态进展"));
});

test("状态文本：[进展] 取值优先级=实时登记 > 快照 tH 兜底；兜底 vI 180 截断", async () => {
  const snapshot = makeSnapshot([
    { role: "user", content: "帮我修登录" },
    {
      role: "assistant",
      content: "旧回复",
      parts: [{ type: "content", content: "旧回复" }],
    },
    {
      role: "assistant",
      content: "最新回复",
      thought: "思路",
      parts: [
        { type: "content", content: "  正在   检查 " },
        { type: "tool-call", toolIndex: 0 },
      ],
      tools: [{ toolName: "bash", status: "completed", input: { command: "ls" } }],
    },
  ]);
  // 无实时登记 → 快照兜底：末条 assistant 末个 part=tool-call → 工具行（qZ）
  const fixture = makeStatusFixture(runningMeta, snapshot);
  const fallback = await renderStatus(fixture, taskContext());
  assert.ok(fallback.includes("进展: bash [completed]: ls"), fallback);

  // 实时登记优先
  fixture.bridge.updateLiveStatusProgress("task-1", {
    type: "agent_message_chunk",
    content: "实时优先",
  } as unknown as BotTaskStreamEvent);
  assert.ok((await renderStatus(fixture, taskContext())).includes("进展: 实时优先"));

  // 兜底 tH：content part 优先（normalizeInlineText 折叠空白）；超长 vI 180 截断（177 + ...）
  const contentSnapshot = makeSnapshot([
    {
      role: "assistant",
      content: "x".repeat(300),
      parts: [{ type: "content", content: "x".repeat(300) }],
    },
  ]);
  const truncated = readLatestTaskProgress(contentSnapshot);
  assert.equal(truncated, `${"x".repeat(177)}...`);
  const spaced = readLatestTaskProgress(
    makeSnapshot([
      { role: "assistant", content: "c", parts: [{ type: "content", content: "  正在   检查\n登录 " }] },
    ]),
  );
  assert.equal(spaced, "正在 检查 登录");

  // 兜底也没有 → 省略该行
  const bare = makeStatusFixture(runningMeta, makeSnapshot([{ role: "user", content: "hi" }]));
  assert.ok(!(await renderStatus(bare, taskContext())).includes("进展"));
});

test("状态文本：[已工作] 缺省省略（meta 拿不到）；已结束任务耗时=updatedAt-createdAt", async () => {
  const noMeta = makeStatusFixture(null);
  const text = await renderStatus(noMeta, taskContext());
  assert.ok(!text.includes("已工作"), text);
  assert.ok(!text.includes("进展"), text);

  const finishedMeta = {
    taskId: "task-1",
    traceId: "trace-1",
    title: "t",
    workspacePath: "/ws-1",
    createdAt: 1000,
    updatedAt: 1000 + 2 * MINUTE + 5000,
    mode: "yolo",
    status: "completed",
  } as unknown as ZCodeTaskMeta;
  const fixture = makeStatusFixture(finishedMeta);
  const finished = await renderStatus(fixture, taskContext());
  assert.ok(finished.includes("已工作: 2m 5s"), finished);
  assert.ok(finished.includes("状态: ✅ 已完成"), finished);
});

test("进度/工具行构造器：formatStatusStreamToolProgress 与 1000 尾窗截断", () => {
  assert.equal(
    formatStatusStreamToolProgress({ title: "run", status: "completed", input: { command: "ls" } }),
    "run [completed]: ls",
  );
  assert.equal(formatStatusStreamToolProgress({ kind: "read" }), "read");
  const tail = truncateLiveStatusProgressText("a".repeat(1200));
  assert.equal(tail.length, 1000);
});
