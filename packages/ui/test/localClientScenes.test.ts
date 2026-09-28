// FreeCodeZ fork(2026-09-27 模板内容本地化,docs/spec/local-client-scenes.md):
// 定时/闲时任务模板与输入框推荐提示词原由运行时请求 ZCode 后端 /api/v1/client/scenes
// 下发,而默认端点自 P4 §3.2 起是占位域 https://freecodez.local(不解析),请求必然失败,
// 模板长期为空(用户侧表现为「无可用模板」)。改为随包内置后,本用例锁住两件事:
//   1) 服务返回的内置数据确实是三个被消费的 scene,且不含无人读取的远程 scene;
//   2) 这些数据经过两份真实映射函数后,模板与推荐提示词的条数/标题/cron 与快照一致,
//      没有条目被映射规则(标题为空或 cron 无法安全编辑)静默拒绝。
// 运行:TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/localClientScenes.test.ts
// (被测模块内部用 @/ 别名,tsx 需要指向 ui 的 tsconfig 才能解析;不带别名的既有用例无此要求。)
import assert from "node:assert/strict";
import test from "node:test";
import { isValidCronExpr } from "@zcode/services";
import { createClientScenesService } from "@zcode/services/node";
import { mapClientScenesToAutomationTemplates } from "../src/settings/automationTemplateCatalog.js";
import {
  DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK,
  mapClientScenesToDraftSuggestedPromptItems,
} from "../src/v4/draftSuggestedPromptItems.js";

/** 快照事实（2026-09-27 拉取 ZCode 后端 /api/v1/client/scenes）。 */
const EXPECTED_SCHEDULED: ReadonlyArray<{ id: string; title: string; cronExpr: string }> = [
  { id: "item-morningDevBrief", title: "晨会动态", cronExpr: "0 9 * * 1-5" },
  { id: "item-dailyRiskScan", title: "风险扫描", cronExpr: "0 10 * * *" },
  { id: "item-weeklyReleaseBrief", title: "发布简报", cronExpr: "0 16 * * 5" },
  { id: "item-documentationSyncCheck", title: "文档同步检查", cronExpr: "0 15 * * 3" },
];

const EXPECTED_OFF_PEAK: ReadonlyArray<{ id: string; title: string }> = [
  { id: "item-standupGitSummary", title: "Git 站会摘要" },
  { id: "item-ciFlakyReport", title: "CI 失败与不稳定测试报告" },
  { id: "item-documentationSyncCheck", title: "文档同步检查" },
];

const EXPECTED_DRAFT_TITLES = ["周报总结", "报错修复", "PPT 制作", "闲时任务"];

async function loadScenes() {
  const response = await createClientScenesService().list();
  assert.equal(response.code, 0, "内置 scenes 不应带业务错误码");
  return response.data;
}

test("内置 scenes 只含三个被消费的 scene，不含无人读取的远程 scene", async () => {
  const scenes = await loadScenes();
  assert.deepEqual(scenes.map((scene) => scene.scene).sort(), [
    "draft-suggestion",
    "off-peak-task",
    "scheduled-task",
  ]);
  // 数据来源是本地常量，list() 必须同步可得，不产生任何网络往返。
  const startedAt = Date.now();
  await createClientScenesService().list();
  assert.ok(Date.now() - startedAt < 50, "list() 不应等待网络");
});

test("定时任务模板映射出 4 条，标题与 cron 与快照一致", async () => {
  const scenes = await loadScenes();
  const catalog = mapClientScenesToAutomationTemplates(scenes, isValidCronExpr);

  assert.deepEqual(
    catalog.rejectedScheduledTemplateIds,
    [],
    "不应有任何定时模板被映射规则静默拒绝",
  );
  assert.equal(catalog.scheduled.length, EXPECTED_SCHEDULED.length);

  for (const expected of EXPECTED_SCHEDULED) {
    const actual = catalog.scheduled.find((template) => template.id === expected.id);
    assert.ok(actual, `缺少定时模板 ${expected.id}`);
    assert.equal(actual.title.cn, expected.title);
    // cron 必须既能被 Croner 校验、又落在 Automation 编辑器可无损可视化的五段子集，
    // 否则模板点进去会被表单静默改写（automationTemplateCatalog 的拒绝条件）。
    assert.equal(actual.cronExpr, expected.cronExpr);
    assert.ok(isValidCronExpr(actual.cronExpr), `${expected.id} cron 非法`);
  }
});

test("闲时任务模板映射出 3 条，标题与快照一致", async () => {
  const scenes = await loadScenes();
  const catalog = mapClientScenesToAutomationTemplates(scenes, isValidCronExpr);

  assert.equal(catalog.offPeak.length, EXPECTED_OFF_PEAK.length);
  for (const expected of EXPECTED_OFF_PEAK) {
    const actual = catalog.offPeak.find((template) => template.id === expected.id);
    assert.ok(actual, `缺少闲时模板 ${expected.id}`);
    assert.equal(actual.title.cn, expected.title);
  }
});

test("输入框推荐提示词映射出 4 条，跳转动作与插件绑定不丢", async () => {
  const scenes = await loadScenes();
  const items = mapClientScenesToDraftSuggestedPromptItems(scenes);

  assert.deepEqual(
    items.map((item) => item.label.cn),
    EXPECTED_DRAFT_TITLES,
  );

  const idleTask = items.find((item) => item.id === "item-032195");
  assert.ok(idleTask, "缺少「闲时任务」推荐项");
  assert.deepEqual(idleTask.actions, [DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK]);

  // 「PPT 制作」经 defaults.plugins 引用 plugins option 条目，绑定必须能解析出来：
  // stableId 取被引用条目的 contents（插件 id），label 取其 labels（展示名）。
  const ppt = items.find((item) => item.id === "item-4YwHmg");
  assert.ok(ppt, "缺少「PPT 制作」推荐项");
  assert.equal(ppt.plugin?.stableId, "document-skills@zcode-plugins-official");
  assert.equal(ppt.plugin?.label.cn, "文档技能");
});
