// 0C-1③（升级实施手册）：actor 工具面减法黑名单转白名单。黑名单盖不到 MCP/plugin
// 动态注册的工具（mcp__* 全量下放给无人值守 yolo actor）；白名单结构性排除动态工具，
// 内建工作面全保留（与旧减法语义等价，零行为收窄）。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { workflowActorToolPolicy, ACTOR_ALLOWED_TOOLS } from "../src/app/workflow-actor-tools.js";

const here = dirname(fileURLToPath(import.meta.url));

test("白名单不含交互/编排/自动化/越权工具", () => {
  const allowlist = workflowActorToolPolicy().toolAllowlist;
  for (const banned of [
    "AskUserQuestion",
    "EnterPlanMode",
    "ExitPlanMode",
    "CreateWorkflow",
    "AmendWorkflow",
    "SaveWorkflow",
    "ResumeWorkflowRun",
    "ReadSessionContext",
    "ResolveWorkflowQuestion",
    "CronCreate",
    "OffPeakCreate",
  ]) {
    assert.ok(!allowlist.includes(banned), `${banned} 不得出现在 actor 白名单`);
  }
});

test("内建工作面全保留（与旧减法语义等价）", () => {
  for (const work of [
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Bash",
    "WebSearch",
    "WebFetch",
    "ImageSearch",
    "ImageUnderstand",
    "ViewImage",
    "TodoWrite",
    "TodoRead",
    "Agent",
    "SendMessage",
    "TaskOutput",
    "TaskStop",
    "Skill",
    "ListModels",
    "GetWorkflowRun",
    "ListWorkflowRuns",
    "ListSavedWorkflows",
    "EvalWorkflowSnippet",
    "submit_result",
    "escalate",
  ]) {
    assert.ok(ACTOR_ALLOWED_TOOLS.includes(work), `${work} 必须保留（白名单漏列=行为收窄）`);
  }
  // 动态工具结构性排除：白名单里没有任何 mcp__/plugin 前缀名。
  assert.ok(
    ACTOR_ALLOWED_TOOLS.every((name) => !name.startsWith("mcp__") && !name.includes(":")),
  );
});

test("锚定：脚本声明面与策略白名单取交集（不是覆盖）", () => {
  const source = readFileSync(
    join(here, "../src/app/script-workflow-child-runtime.ts"),
    "utf8",
  );
  assert.match(
    source,
    /policyAllowlist\.filter\(\(toolName\) => declaredTools\.includes\(toolName\)\)/,
    "声明只能在白名单内收窄——交集合并，防止策略覆盖 opts.tools",
  );
});

test("锚定：跨进程 amend 裸 throw 已改结构化拒绝", () => {
  const source = readFileSync(
    join(here, "../src/app/dynamic-workflow-run-submit.ts"),
    "utf8",
  );
  assert.match(
    source,
    /return \{ ok: false, reason: "predecessor_running_elsewhere" \};/,
    "buildImportedCache 被拒（跨进程持 run）必须结构化返回而非 throw",
  );
  assert.match(source, /predecessor run is owned by another process/);
});
