// B4 回归（2026-10-07）：宿主 ZCode 的 shell 集成会把 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
// 写进会话环境，指向官方运行时配置（oauth/account access 形态）；FC 的 fork schema 只认
// api-key/none，直读必炸构建。构建脚本此前是 env 泄漏坑的存活面（6a60069 只盖 GUI 运行时
// resolver、D1 只盖 CLI 启动清洗）。修复语义与运行时一致：显式路径先过 fork schema 预检，
// 兼容 → 采信；不兼容/不存在 → warn 一次 + 回退仓库基线 config/provider/zcode-builtin.json。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBuiltinProviderConfig } from "../../../../../scripts/builtin-provider-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const baselinePath = join(repoRoot, "config", "provider", "zcode-builtin.json");
const baselineContent = readFileSync(baselinePath, "utf8");

// 官方 oauth 形态的最小差异样本：把基线里某个 api-key access 改成 oauth——fork schema
// 的 access.type 只收 "api-key" | "none"，与泄漏的官方配置同型失败。
function writeForeignConfig() {
  const parsed = JSON.parse(baselineContent);
  const rule = parsed.config.providerConfigRules.templateRules.find(
    (candidate) => candidate.config?.access?.type === "api-key",
  );
  assert.ok(rule, "fixture 前置：基线必须含 api-key 模板（否则样本构造失效）");
  rule.config.access.type = "oauth";
  const dir = mkdtempSync(join(tmpdir(), "fc-builtin-provider-leak-"));
  const filePath = join(dir, "zcode-builtin.json");
  writeFileSync(filePath, JSON.stringify(parsed));
  return filePath;
}

async function withCapturedWarn(run) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(String(args[0]));
  try {
    const value = await run();
    return { value, warnings };
  } finally {
    console.warn = originalWarn;
  }
}

test("外来 oauth 形态配置（泄漏场景）→ warn + 回退仓库基线，不再炸构建", async () => {
  const foreignPath = writeForeignConfig();
  const { value: result, warnings } = await withCapturedWarn(() =>
    loadBuiltinProviderConfig({ root: repoRoot, env: { FREECODEZ_ENV: "test", ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: foreignPath } }),
  );
  assert.equal(result.sourcePath, baselinePath);
  assert.equal(result.content, baselineContent);
  assert.equal(result.environment, "test");
  assert.equal(warnings.filter((line) => line.includes("falling back to repo baseline")).length, 1);
});

test("兼容的显式配置（基线副本）→ 采信显式路径，不告警", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fc-builtin-provider-valid-"));
  const filePath = join(dir, "zcode-builtin.json");
  writeFileSync(filePath, baselineContent);
  const { value: result, warnings } = await withCapturedWarn(() =>
    loadBuiltinProviderConfig({ root: repoRoot, env: { FREECODEZ_ENV: "test", ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: filePath } }),
  );
  assert.equal(result.sourcePath, filePath);
  assert.deepEqual(warnings, []);
});

test("显式路径不存在 → 同样回退基线（外来文件不可信，缺文件也不打死构建）", async () => {
  const missingPath = join(mkdtempSync(join(tmpdir(), "fc-builtin-provider-missing-")), "absent.json");
  const { value: result, warnings } = await withCapturedWarn(() =>
    loadBuiltinProviderConfig({ root: repoRoot, env: { FREECODEZ_ENV: "test", ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: missingPath } }),
  );
  assert.equal(result.sourcePath, baselinePath);
  assert.equal(warnings.filter((line) => line.includes("falling back to repo baseline")).length, 1);
});

test("未设显式路径 → 基线直读行为保持（含坏基线时的严格报错语义）", async () => {
  const result = await loadBuiltinProviderConfig({ root: repoRoot, env: { FREECODEZ_ENV: "test" } });
  assert.equal(result.sourcePath, baselinePath);
  assert.equal(result.content, baselineContent);
});
