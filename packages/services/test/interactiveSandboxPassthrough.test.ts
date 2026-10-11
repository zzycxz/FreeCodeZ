// 交互会话沙箱全局开关的透传合成测试（沙箱规格书 R2"高级设置提供全局开关"）：
// automation 派发（automationId 存在）必须向 createSession/resumeSession 显式传布尔
// ——未勾时显式 false，抵御 zcodeAgentService.createSession 内部的全局开关回退
// （每条 automation 可选语义不被全局开覆盖）；交互/远控链（无 automationId）不带
// 字段（undefined），由 service 层按高级设置回退。另锚定 resumeTask 此前把
// sandboxEnabled/automationId 丢弃的修复（E-S4 声称的 resume 边界回传）。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeSessionStateSnapshotSchema,
  type ZCodeSessionStateSnapshot,
} from "@zcode/shared";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import { Emitter } from "@zcode/rpc";

interface Harness {
  service: ReturnType<typeof createZCodeTaskServiceAdapter>;
  created: Array<Record<string, unknown> | undefined>;
  resumed: Array<Record<string, unknown> | undefined>;
  dir: string;
}

async function createHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-passthrough-"));
  const taskIndexRepo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  const created: Array<Record<string, unknown> | undefined> = [];
  const resumed: Array<Record<string, unknown> | undefined> = [];
  const buildSnapshot = (sessionId: string): ZCodeSessionStateSnapshot =>
    zcodeSessionStateSnapshotSchema.parse({
      protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION },
      session: {
        sessionId,
        workspace: { workspacePath: "/tmp/ws", workspaceKey: "/tmp/ws" },
        sessionKind: "interactive",
        title: "t",
        mode: "build",
        status: "idle",
        createdAt: 1,
        updatedAt: 2,
      },
      settings: {
        model: { available: [] },
        thoughtLevel: { enabled: false, available: [] },
        mode: { current: "build" },
      },
      projection: {
        sessionId,
        status: "idle",
        mode: "build",
        turnCount: 0,
        totalTokenCount: 0,
        contextUsed: 0,
        contextWindow: 200000,
        pendingPermissions: [],
        activeToolCalls: [],
        backgroundJobs: [],
      },
      runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] },
      messages: [],
    });
  const disposable = () => ({ dispose() {} });
  type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];
  const service = createZCodeTaskServiceAdapter({
    taskIndexRepo,
    zcodeAgentService: {
      async createSession(input: Record<string, unknown>) {
        created.push(input);
        return buildSnapshot(String(input.sessionId ?? "task_1"));
      },
      async resumeSession(input: Record<string, unknown>) {
        resumed.push(input);
        return buildSnapshot(String(input.sessionId ?? "task_1"));
      },
      disposeAll() {},
    } as unknown as Options["zcodeAgentService"],
    taskIndexSyncer: {
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      getWorkspaceEmitter: () => new Emitter(),
      emitWorkspaceTaskListChanged: () => {},
      ensureSessionSubscription: () => disposable(),
      disposeAll() {},
    } as unknown as Options["taskIndexSyncer"],
  });
  return { service, created, resumed, dir };
}

const WORKSPACE = { workspacePath: "/tmp/ws" };

test("createTask：automation 派发显式传布尔（勾=true / 未勾=false 抵御全局回退）", async () => {
  const h = await createHarness();
  try {
    await h.service.createTask({
      ...WORKSPACE,
      taskId: "a1",
      automationId: "auto-1",
      sandboxEnabled: true,
    } as never);
    await h.service.createTask({
      ...WORKSPACE,
      taskId: "a2",
      automationId: "auto-2",
    } as never);
    assert.equal(
      h.created[0]?.sandboxEnabled,
      true,
      "automation 勾选 → 显式 true",
    );
    assert.equal(
      h.created[1]?.sandboxEnabled,
      false,
      "automation 未勾 → 显式 false（不被全局开覆盖）",
    );
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test("createTask：交互/远控链不带字段（undefined 交给 service 全局回退）", async () => {
  const h = await createHarness();
  try {
    await h.service.createTask({ ...WORKSPACE } as never);
    assert.equal(
      "sandboxEnabled" in (h.created[0] ?? {}),
      false,
      "交互链不得预设沙箱位（undefined 时 service 按高级设置回退）",
    );
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test("resumeTask：automation 恢复链透传显式布尔（此前丢弃字段的回归锚）", async () => {
  const h = await createHarness();
  try {
    await h.service.resumeTask({
      ...WORKSPACE,
      taskId: "t1",
      automationId: "auto-1",
      sandboxEnabled: true,
    } as never);
    await h.service.resumeTask({
      ...WORKSPACE,
      taskId: "t2",
      automationId: "auto-2",
    } as never);
    assert.equal(h.resumed[0]?.sandboxEnabled, true);
    assert.equal(
      h.resumed[1]?.sandboxEnabled,
      false,
      "未勾 automation 的恢复同样显式 false",
    );
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test("resumeTask：交互冷恢复不带字段（跟随高级设置全局开关）", async () => {
  const h = await createHarness();
  try {
    await h.service.resumeTask({ ...WORKSPACE, taskId: "t3" } as never);
    assert.equal("sandboxEnabled" in (h.resumed[0] ?? {}), false);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});
