// 0-4 修复测试（升级实施手册）：bots 任务建/续边界强制注入沙箱。
// 背景：taskBridge 建任务强制 yolo（§6.9 modeLocked）且公网聊天消息可驱动，但从不注入
// sandboxEnabled——一条 Telegram/飞书消息即可让无沙箱会话执行任意 bash。修复后 create 与
// resume 两个边界都注入（任务 meta 不持久化沙箱位，resume 边界必须重新注入）。
import assert from "node:assert/strict";
import test from "node:test";
import { BotTaskBridge } from "../src/bots/taskBridge.js";
import type { BotTaskServiceLike } from "../src/bots/taskServiceLike.js";
import type { ZCodeTaskMeta } from "@zcode/shared";

function fakeTaskService(captured: {
  create?: Record<string, unknown>;
  resume?: Record<string, unknown>;
}): BotTaskServiceLike {
  const meta: ZCodeTaskMeta = {
    taskId: "task_1",
    title: "t",
    status: "idle",
    mode: "build",
    updatedAt: "2026-10-05T00:00:00.000Z",
    createdAt: "2026-10-05T00:00:00.000Z",
  } as unknown as ZCodeTaskMeta;
  return {
    createTask: async (params: Record<string, unknown>) => {
      captured.create = params;
      return meta;
    },
    setMode: async () => meta,
    resumeTask: async (params: Record<string, unknown>) => {
      captured.resume = params;
      return meta;
    },
  } as unknown as BotTaskServiceLike;
}

test("createBotTask：建任务强制注入 sandboxEnabled=true", async () => {
  const captured: { create?: Record<string, unknown> } = {};
  const bridge = new BotTaskBridge({ taskService: fakeTaskService(captured) });
  await bridge.createBotTask({
    context: { workspacePath: "/tmp/ws", workspaceIdentity: "/tmp/ws" },
    modelSelection: undefined,
  });
  assert.equal(captured.create?.sandboxEnabled, true, "bot 建任务必须带 sandboxEnabled=true");
});

test("resumeBotTask：冷恢复/续跑同样注入 sandboxEnabled=true", async () => {
  const captured: { resume?: Record<string, unknown> } = {};
  const bridge = new BotTaskBridge({ taskService: fakeTaskService(captured) });
  await bridge.resumeBotTask({
    context: { workspacePath: "/tmp/ws", workspaceIdentity: "/tmp/ws" },
    taskId: "task_1",
  });
  assert.equal(captured.resume?.sandboxEnabled, true, "bot 续跑必须带 sandboxEnabled=true");
});
