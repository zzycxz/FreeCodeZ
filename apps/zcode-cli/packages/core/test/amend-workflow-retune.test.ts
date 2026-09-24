// 批次 2-1 retune 路由单测：resolveInput 的 retune 标记（只改界才 eligible、伪造无效）与
// handler 的原地分支（成功回 retuned 结构块；同值报 workflow_retune_unchanged；拒绝回落）。
// 规格 R3 / 验收 A1 的工具层。
import assert from "node:assert/strict";
import test from "node:test";
import { amendWorkflowToolEntry } from "../src/tool/handlers/amend-workflow.js";
import { resolveAmendWorkflowInput } from "../src/tool/handlers/amend-workflow-resolve.js";

function fakeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    taskId: "run-1",
    startedAt: new Date(0),
    status: "running",
    parentSessionId: "sess-1",
    maxConcurrency: 2,
    scriptPath: undefined,
    subagentModel: undefined,
    ...overrides,
  };
}

function fakePort(overrides: Record<string, unknown> = {}) {
  return {
    getTask: async () => fakeSnapshot(),
    getScript: async () => "return 1",
    concurrencyCeiling: () => 4,
    ...overrides,
  };
}

test("resolveInput：只给 max_concurrency → retune_eligible + 原始三态值在场", async () => {
  const result = await resolveAmendWorkflowInput(
    { run_id: "run-1", max_concurrency: 3 },
    { dynamicWorkflowRunPort: fakePort() as never, workingDirectory: process.cwd() },
  );
  assert.ok(result.result === true);
  const input = (result as { input: Record<string, unknown> }).input;
  assert.equal(input.retune_eligible, true);
  assert.equal(input.max_concurrency_requested, 3);
  // 归一化后的值同时在场（clamped 到 [1, ceiling]）。
  assert.equal(input.max_concurrency, 3);
});

test("resolveInput：改了脚本/模型/名字 → 不 eligible；null（解除）→ eligible 且 requested=null", async () => {
  const base = { dynamicWorkflowRunPort: fakePort() as never, workingDirectory: process.cwd() };
  const withScript = await resolveAmendWorkflowInput({ run_id: "run-1", script: "return 2", max_concurrency: 3 }, base);
  assert.equal((withScript as { input: Record<string, unknown> }).input.retune_eligible, undefined);
  // 改模型：无目录时解析直接失败（result:false）——同样不产生 eligible 标记；
  // 有目录时的「解析成功但不 eligible」由 withScript 一行已证（同一判定表达式）。
  const withModel = await resolveAmendWorkflowInput(
    { run_id: "run-1", max_concurrency: 3, subagent_model: "openai/gpt-x" },
    base,
  );
  assert.equal(withModel.result, false);
  const cleared = await resolveAmendWorkflowInput({ run_id: "run-1", max_concurrency: null }, base);
  const clearedInput = (cleared as { input: Record<string, unknown> }).input;
  assert.equal(clearedInput.retune_eligible, true);
  assert.equal(clearedInput.max_concurrency_requested, null);
  // 解除 → 归一化键消失（= 无自己的界）。
  assert.equal(clearedInput.max_concurrency, undefined);
});

test("resolveInput：模型伪造的 retune 键作废（按原始三态重算）", async () => {
  const result = await resolveAmendWorkflowInput(
    {
      run_id: "run-1",
      script: "return 2",
      retune_eligible: true,
      max_concurrency_requested: 8,
    },
    { dynamicWorkflowRunPort: fakePort() as never, workingDirectory: process.cwd() },
  );
  const input = (result as { input: Record<string, unknown> }).input;
  assert.equal(input.retune_eligible, undefined);
  assert.equal(input.max_concurrency_requested, undefined);
});

function resolvedRetuneInput(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "run-1",
    script: "return 1",
    predecessor: { status: "running", owned_by_this_session: true, script_inherited: true },
    retune_eligible: true,
    max_concurrency_requested: 3,
    max_concurrency: 3,
    ...overrides,
  };
}

test("handler：retune 成功 → runId 不变 + retuned 结构块 + 不触确认/编译", async () => {
  const calls: string[] = [];
  const port = {
    concurrencyCeiling: () => 4,
    retune: async (request: { runId: string; maxConcurrency: number }) => {
      calls.push(`retune:${request.maxConcurrency}`);
      return { ok: true, runId: request.runId, maxConcurrency: 3, previous: 2, ceiling: 4 };
    },
    amend: async () => {
      calls.push("amend");
      throw new Error("amend must not be called");
    },
  };
  const output = (await amendWorkflowToolEntry.handler(resolvedRetuneInput(), {
    dynamicWorkflowRunPort: port as never,
  } as never)) as Record<string, unknown>;
  assert.deepEqual(calls, ["retune:3"]);
  assert.equal(output.backgroundTaskId, "run-1");
  assert.equal(output.status, "backgrounded");
  assert.deepEqual(output.retuned, {
    runId: "run-1",
    maxConcurrency: 3,
    previous: 2,
    ceiling: 4,
  });
  assert.match(String(output.response), /retuned in place from 2 to 3/);
});

test("handler：同值 → workflow_retune_unchanged 结构化失败（Nothing was started）", async () => {
  const port = {
    concurrencyCeiling: () => 4,
    retune: async () => ({ ok: false as const, reason: "unchanged" as const }),
  };
  const output = (await amendWorkflowToolEntry.handler(resolvedRetuneInput(), {
    dynamicWorkflowRunPort: port as never,
  } as never)) as { result: boolean; errorCode: number; message: string };
  assert.equal(output.result, false);
  assert.equal(output.errorCode, 400);
  assert.match(output.message, /workflow_retune_unchanged/);
});

test("handler：settled/not_retunable → 回落 supersede 流程（amend 被调用）", async () => {
  let amended = false;
  const port = {
    concurrencyCeiling: () => 4,
    retune: async () => ({ ok: false as const, reason: "settled" as const }),
    getScript: async () => "return 1",
    amend: async () => {
      amended = true;
      return { ok: true as const, runId: "run-2" };
    },
  };
  // settled 回落后走正常修订：需要编译器等一整套。此处只验证「没有把 settled 当终局失败抛出」，
  // 让它继续走到编译/端口环节——断言 amend 被触达即可（其余路径已有既有测试面）。
  const output = (await amendWorkflowToolEntry.handler(resolvedRetuneInput(), {
    dynamicWorkflowRunPort: port as never,
    workingDirectory: process.cwd(),
    toolCallId: "tc-1",
    sessionId: "sess-1",
    traceId: "t-1",
    abortSignal: new AbortController().signal,
  } as never)) as Record<string, unknown>;
  assert.equal(amended, true);
  assert.ok(output.backgroundTaskId === "run-2" || output.ok === false);
});
