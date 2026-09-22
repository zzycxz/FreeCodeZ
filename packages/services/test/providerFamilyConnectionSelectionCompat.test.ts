/**
 * C5（docs/spec/model-provider-intake.md §7/§8）：已持久化的连接方式判别值
 * `kind:"start-plan"` 必须保持可读。bigmodel+zai 账号族已整体移除（R1/A2'），但该
 * 判别字面量是本地 setting.json 的存量数据：从 zod 判别联合中删除会让整份
 * appSettings safeParse 失败，settingService 读取边界会静默回退全默认值
 * （语言、工作区历史等一次性丢失）。schema 必须保留 tombstone 分支。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appSettingsSchema,
  appSettingsPatchSchema,
  providerFamilyConnectionSelectionSettingsSchema,
} from "@zcode/shared";

const legacySelections = {
  zai: { kind: "start-plan" },
  bigmodel: { kind: "start-plan" },
} as const;

test('存量 kind:"start-plan" 连接选择仍可解析（C5 主用例）', () => {
  const parsed =
    providerFamilyConnectionSelectionSettingsSchema.safeParse(legacySelections);
  assert.equal(parsed.success, true, "连接方式判别联合必须保留 start-plan tombstone 分支");

  const settings = appSettingsSchema.safeParse({
    providerFamilyConnectionSelections: legacySelections,
    providerFamilyDomain: "zai",
    providerFamilyDomainUpdatedAt: 1,
    providerFamilyDomainMigrated: true,
  });
  assert.equal(
    settings.success,
    true,
    `整份设置解析失败会静默回退默认值: ${JSON.stringify(settings.error?.issues)}`,
  );
  if (settings.success) {
    // tombstone 只需可读；值必须原样保留，不得在解析阶段被改写或丢弃。
    assert.deepEqual(settings.data.providerFamilyConnectionSelections, legacySelections);
    assert.equal(settings.data.providerFamilyDomain, "zai");
  }
});

test("start-plan 与 individual/team 存量混合时互不污染（C5 兼容面）", () => {
  const mixed = {
    zai: { kind: "start-plan" },
    bigmodel: {
      kind: "team-coding-plan",
      productId: "product-1",
      organizationId: "org-1",
      projectId: "project-1",
    },
  } as const;
  const settings = appSettingsSchema.safeParse({
    providerFamilyConnectionSelections: mixed,
  });
  assert.equal(settings.success, true);
  if (settings.success) {
    assert.deepEqual(settings.data.providerFamilyConnectionSelections, mixed);
  }
});

test("appSettingsPatch 读取边界同样接受 start-plan 存量（C5 写路径）", () => {
  const patch = appSettingsPatchSchema.safeParse({
    providerFamilyConnectionSelections: legacySelections,
  });
  assert.equal(patch.success, true);
});
