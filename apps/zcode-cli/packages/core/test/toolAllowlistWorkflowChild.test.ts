// 0C-1③：workflow_child 的 allowlist 推导必须无条件补回生命周期通道
//（submit_result/escalate）——注册面的 allowedTools 过滤不区分来源，脚本声明面与
// 策略白名单的交集可能把控制工具挤掉；typed actor 失去 submit_result 就永远无法结束。
import assert from "node:assert/strict";
import test from "node:test";
import { resolveBuiltInToolAllowlist } from "../src/runtime/helpers/tool-allowlist.js";

test("声明面收窄到只剩 Read 时，submit_result/escalate 仍被补回", () => {
  const narrowed = resolveBuiltInToolAllowlist({
    toolAllowlist: ["Read"],
    taskType: "workflow_child",
  } as never);
  assert.ok(narrowed?.includes("submit_result"));
  assert.ok(narrowed?.includes("escalate"));
  assert.ok(narrowed?.includes("Read"));
});

test("白名单已含控制工具时幂等（不重复追加）", () => {
  const base = ["Read", "submit_result", "escalate"];
  const result = resolveBuiltInToolAllowlist({
    toolAllowlist: base,
    taskType: "workflow_child",
  } as never);
  assert.deepEqual(result, base);
});

test("非 workflow_child 会话不补回（控制通道补回是 actor 专属语义）", () => {
  const mainSession = resolveBuiltInToolAllowlist({
    toolAllowlist: ["Read", "Write"],
  } as never);
  assert.deepEqual(mainSession, ["Read", "Write"]);
});

test("subagent_child 的 RespondToCoordinator 补回不回归（既有语义）", () => {
  const result = resolveBuiltInToolAllowlist({
    toolAllowlist: ["Read"],
    taskType: "subagent_child",
  } as never);
  assert.ok(result?.includes("RespondToCoordinator"));
});
