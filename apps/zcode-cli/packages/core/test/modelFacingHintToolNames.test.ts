// A4 守卫测试：面向模型的提示文案（system-reminder 常量）里引用的工具名必须真实
// 存在于内置注册表。背景：gh 限流提示曾指引"use ScheduleWakeup"——该名字只存在于
// 排序白名单（provider-visible-order），无 handler/contract，模型收到无法执行的指令。
// 守卫口径：提示中出现的"排序白名单里有、注册表里没有"的幽灵名即为违规（这正是
// ScheduleWakeup/LSP/NotebookEdit/TaskCreate 们的唯一来源）；普通英文词不受影响。
import assert from "node:assert/strict";
import test from "node:test";
import { getGhRateLimitHint } from "../src/tool/handlers/bash-gh-rate-limit.js";
import { builtInTools } from "../src/tool/handlers/index.js";
import { SORTED_PROVIDER_TOOL_NAMES } from "../src/tool/provider-visible-order.js";

test("gh 限流提示不引用幽灵工具名，且给出可行的等待手段", () => {
  // 冷却窗口 60s：同进程内只取第一次调用（后续调用返回 undefined 属预期）。
  const hint = getGhRateLimitHint("gh pr list", "API rate limit exceeded");
  assert.ok(hint, "命中限流时应产生提示");

  const registered = new Set(builtInTools.map((entry) => entry.metadata.name));
  const orderNames: ReadonlySet<string> = SORTED_PROVIDER_TOOL_NAMES;
  const ghosts = [...orderNames].filter((name) => !registered.has(name));
  assert.ok(ghosts.length > 0, "排序白名单应存在幽灵名（守卫前提）");
  const referencedGhosts = ghosts.filter((name) => hint.includes(name));
  assert.deepEqual(
    referencedGhosts,
    [],
    `提示引用了幽灵工具名：${referencedGhosts.join(", ")}（只有排序占位、无 handler）`,
  );

  assert.match(hint, /run_in_background/);
  assert.match(hint, /TaskOutput/);
});
