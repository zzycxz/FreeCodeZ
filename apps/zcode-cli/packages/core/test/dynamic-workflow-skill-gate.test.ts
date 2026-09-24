// skill 门控（R1）单测：豁免判定、428 拒收与向后兼容缺省。
// 规格：规格书-FreeCodeZ-上游修复移植.md §3 R1、§8 验收 A5/A6/A7。
import assert from "node:assert/strict";
import test from "node:test";
import {
  amendWorkflowNeedsSkill,
  createWorkflowNeedsSkill,
  requireDynamicWorkflowSkill,
} from "../src/tool/handlers/dynamic-workflow-skill-gate.js";
import { CREATE_WORKFLOW_TOOL_DESCRIPTION } from "../src/tool/handlers/create-workflow-description.js";
import { SAVE_WORKFLOW_TOOL_DESCRIPTION } from "../src/tool/handlers/save-workflow-description.js";
import { EVAL_WORKFLOW_SNIPPET_TOOL_DESCRIPTION } from "../src/tool/handlers/eval-workflow-snippet-description.js";

test("createWorkflowNeedsSkill：仅 saved-only 豁免（A6）", () => {
  assert.equal(createWorkflowNeedsSkill({ saved: { name: "pr-review" } }), false);
  assert.equal(createWorkflowNeedsSkill({ script: "return 1" }), true);
  assert.equal(createWorkflowNeedsSkill({ path: "a.dwf.ts" }), true);
  assert.equal(createWorkflowNeedsSkill({ saved: { name: "x" }, script: "return 1" }), true);
  assert.equal(createWorkflowNeedsSkill({}), true);
  assert.equal(createWorkflowNeedsSkill(null), true);
});

test("amendWorkflowNeedsSkill：带 script/path 才需要技能，纯设置修订豁免", () => {
  assert.equal(amendWorkflowNeedsSkill({ script: "return 1" }), true);
  assert.equal(amendWorkflowNeedsSkill({ path: "a.dwf.ts" }), true);
  assert.equal(amendWorkflowNeedsSkill({ run_id: "r1", max_concurrency: 4 }), false);
  assert.equal(amendWorkflowNeedsSkill({ run_id: "r1" }), false);
  assert.equal(amendWorkflowNeedsSkill(null), true);
});

test("requireDynamicWorkflowSkill：未加载报 428 + 引导文案（A5）", () => {
  const refusal = requireDynamicWorkflowSkill("CreateWorkflow", { hasLoadedSkill: () => false });
  assert.ok(refusal);
  assert.equal(refusal.result, false);
  assert.equal(refusal.errorCode, 428);
  assert.match(refusal.message, /CreateWorkflow needs the `dynamic-workflows` skill/);
  assert.match(refusal.message, /Call the Skill tool with skill "dynamic-workflows" first/);
  assert.match(refusal.message, /Nothing was started\./);
});

test("requireDynamicWorkflowSkill：已加载放行；无该能力的宿主缺省放行（向后兼容）", () => {
  assert.equal(requireDynamicWorkflowSkill("CreateWorkflow", { hasLoadedSkill: () => true }), null);
  assert.equal(requireDynamicWorkflowSkill("CreateWorkflow", {}), null);
});

test("三件常驻描述合计 ≤6K 字符（A7；基线 62,784，官方 3.14.3 为 3,415）", () => {
  const total =
    CREATE_WORKFLOW_TOOL_DESCRIPTION.length +
    SAVE_WORKFLOW_TOOL_DESCRIPTION.length +
    EVAL_WORKFLOW_SNIPPET_TOOL_DESCRIPTION.length;
  assert.ok(total <= 6000, `三件合计 ${total} 超出预算`);
  // R2：单件 ≤2K 字符，内联 facade DTS 归零。
  for (const description of [
    CREATE_WORKFLOW_TOOL_DESCRIPTION,
    SAVE_WORKFLOW_TOOL_DESCRIPTION,
    EVAL_WORKFLOW_SNIPPET_TOOL_DESCRIPTION,
  ]) {
    assert.ok(description.length <= 2000, `描述 ${description.length} 超出 2K`);
    assert.ok(!description.includes("The script is checked against these facade declarations"));
  }
});
