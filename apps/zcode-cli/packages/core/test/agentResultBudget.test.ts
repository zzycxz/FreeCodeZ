// B4 单测：子代理回传默认预算 16KB（旧值 120KB 会吃掉父上下文 ~30K token），
// 超限走既有 artifact 信封；AGENT_RESULT_BUDGET_BYTES 环境变量可调回（有界校验）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_AGENT_MODEL_BYTES,
  agentToolEntry,
  resolveAgentResultBudgetBytes,
} from "../src/tool/handlers/agent.js";

test("默认预算收紧为 16KB，元数据与 resultBudget 三处一致", () => {
  assert.equal(DEFAULT_AGENT_MODEL_BYTES, 16_000);
  assert.equal(agentToolEntry.metadata.maxOutputBytes, 16_000);
  assert.equal(agentToolEntry.resultBudget?.maxInlineBytes, 16_000);
  assert.equal(agentToolEntry.resultBudget?.maxModelBytes, 16_000);
  // 超限必须落 artifact（信息不丢，模型可循路径再读）。
  assert.equal(agentToolEntry.resultBudget?.strategy, "artifact");
  assert.equal(agentToolEntry.resultBudget?.artifact?.enabled, true);
});

test("env 覆盖：合法值调回旧口径，非法/越界值回落默认", () => {
  assert.equal(resolveAgentResultBudgetBytes({ AGENT_RESULT_BUDGET_BYTES: "120000" }), 120_000);
  assert.equal(resolveAgentResultBudgetBytes({ AGENT_RESULT_BUDGET_BYTES: "4096" }), 4096);
  assert.equal(resolveAgentResultBudgetBytes({}), 16_000);
  assert.equal(
    resolveAgentResultBudgetBytes({ AGENT_RESULT_BUDGET_BYTES: "not-a-number" }),
    16_000,
  );
  assert.equal(resolveAgentResultBudgetBytes({ AGENT_RESULT_BUDGET_BYTES: "10" }), 16_000);
  assert.equal(resolveAgentResultBudgetBytes({ AGENT_RESULT_BUDGET_BYTES: "9999999" }), 16_000);
});
