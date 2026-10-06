// 显式 Builtin Provider 配置预检回退（纯件测试）：官方 ZCode 配置（oauth 形态）/
// 损坏文件/文件缺失 → 回退 bundled 基线并告警；FreeCodeZ 自有配置 → 放行。
// 背景：官方 ZCode shell 集成把同名 env 键指向官方运行时配置，fork schema 必炸。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetExplicitCompatibilityCacheForTest,
  isExplicitBuiltinProviderConfigCompatible,
  resolveBuiltinProviderConfigPath,
} from "../src/main/desktopProviderConfigExplicit.js";

const REPO_BUILTIN_CONFIG = join(
  import.meta.dirname ?? process.cwd(),
  "../../../config/provider/zcode-builtin.json",
);

function writeTempFixture(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fc-provider-config-test-"));
  const filePath = join(dir, name);
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

test("预检：FreeCodeZ 自有 bundled 配置可解码；官方形态（oauth access）不可解码", () => {
  __resetExplicitCompatibilityCacheForTest();
  assert.equal(isExplicitBuiltinProviderConfigCompatible(REPO_BUILTIN_CONFIG), true);
  const officialStyle = writeTempFixture(
    "official-style.json",
    JSON.stringify({
      schemaVersion: 1,
      revision: 99,
      config: {
        templateRules: [
          { templateId: "zai-oauth", config: { access: { type: "oauth", apiKeyManagementUrl: "https://example" } } },
        ],
      },
    }),
  );
  assert.equal(isExplicitBuiltinProviderConfigCompatible(officialStyle), false);
  // 坏 JSON / 文件缺失同为不可用。
  const broken = writeTempFixture("broken.json", "{ not json");
  assert.equal(isExplicitBuiltinProviderConfigCompatible(broken), false);
  assert.equal(
    isExplicitBuiltinProviderConfigCompatible(join(tmpdir(), "fc-no-such-config.json")),
    false,
  );
});

test("决策：无显式路径用 bundled；兼容显式放行；不兼容/缺失回退 bundled 并告警", () => {
  __resetExplicitCompatibilityCacheForTest();
  const bundled = "/bundled/zcode-builtin.json";
  // 无显式 → bundled，零回调。
  assert.equal(resolveBuiltinProviderConfigPath({ bundledPath: bundled }), bundled);
  // 兼容显式（仓库自有配置）→ 放行。
  assert.equal(
    resolveBuiltinProviderConfigPath({ explicitPath: REPO_BUILTIN_CONFIG, bundledPath: bundled }),
    REPO_BUILTIN_CONFIG,
  );
  // 不兼容显式（官方形态）→ 回退 bundled + 告警携带原因与路径。
  const officialStyle = writeTempFixture(
    "official-style-2.json",
    JSON.stringify({
      schemaVersion: 1,
      revision: 100,
      config: { providerConfigRules: [], templateRules: [{ config: { access: { type: "account" } } }] },
    }),
  );
  const fallbacks: Array<{ path: string; reason: string }> = [];
  assert.equal(
    resolveBuiltinProviderConfigPath({
      explicitPath: officialStyle,
      bundledPath: bundled,
      onFallback: (path, reason) => fallbacks.push({ path, reason }),
    }),
    bundled,
  );
  assert.deepEqual(fallbacks, [{ path: officialStyle, reason: "incompatible" }]);
  // 空串显式等同未设。
  assert.equal(
    resolveBuiltinProviderConfigPath({ explicitPath: "   ", bundledPath: bundled }),
    bundled,
  );
});
