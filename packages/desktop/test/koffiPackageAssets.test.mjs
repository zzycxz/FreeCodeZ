// B1 回归（2026-10-07 端到端实证修复）：verifyCuaPluginAssets 的 koffi 断言必须与 R18 携带
// 策略同源——koffi 仅 darwin 随插件携带（FC 的 koffi 执行层调 macOS AX API；win32 走 vendored
// helper addon、linux 无执行层，插件 node_modules 里的 koffi 在非 darwin 平台没有消费方）。
// 修复前 verify 在 win32 无条件要求 koffi.node，与 staging 的平台过滤正面冲突——干净检出
// win32 打包在 afterPack 必挂（missing staged koffi runtime for win32_x64）。
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCuaPluginAssets } from "../scripts/koffi-package-assets.mjs";
import { HELPER_BUNDLE_ID } from "../../../packages/zcode-cua/broker-helper-constants.js";

// 镜像打包产物布局：resources/glm/packages/zcode-cua-plugin + resources/tools/cua-helper
// （win32）+ resources/cua-helper/FreeCodeZ Computer Use.app（darwin，R19）。
// helper 段用带正确 sha256 的 stub（真实构建中来自 vendored helper-runtime），聚焦插件段。
function buildResources({ withKoffi = false, withMacHelper = false } = {}) {
  const resourcesDir = mkdtempSync(join(tmpdir(), "koffi-assets-verify-"));
  const pluginModules = join(resourcesDir, "glm", "packages", "zcode-cua-plugin", "node_modules");
  mkdirSync(join(pluginModules, "sharp"), { recursive: true });
  writeFileSync(join(pluginModules, "sharp", "package.json"), "{}");
  if (withKoffi) {
    mkdirSync(join(pluginModules, "koffi", "build", "koffi", "darwin_arm64"), { recursive: true });
    writeFileSync(join(pluginModules, "koffi", "index.js"), "");
    writeFileSync(join(pluginModules, "koffi", "build", "koffi", "darwin_arm64", "koffi.node"), "");
  }
  if (withMacHelper) {
    const macHelperApp = join(resourcesDir, "cua-helper", "FreeCodeZ Computer Use.app");
    mkdirSync(join(macHelperApp, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(macHelperApp, "Contents", "MacOS", "FreeCodeZ Computer Use"), "macho");
    mkdirSync(join(macHelperApp, "Contents", "Resources", "dist"), { recursive: true });
    writeFileSync(join(macHelperApp, "Contents", "Resources", "dist", "helper-main.mjs"), "entry");
    mkdirSync(
      join(macHelperApp, "Contents", "Resources", "node_modules", "koffi", "build", "koffi", "darwin_arm64"),
      { recursive: true },
    );
    writeFileSync(
      join(macHelperApp, "Contents", "Resources", "node_modules", "koffi", "build", "koffi", "darwin_arm64", "koffi.node"),
      "native",
    );
    writeFileSync(
      join(macHelperApp, "Contents", "Resources", "identity.json"),
      JSON.stringify({ bundleId: HELPER_BUNDLE_ID }),
    );
  }
  const helperRoot = join(resourcesDir, "tools", "cua-helper");
  mkdirSync(join(helperRoot, "node_modules", "sharp"), { recursive: true });
  writeFileSync(join(helperRoot, "node_modules", "sharp", "package.json"), "{}");
  const entry = "entry.js";
  const addon = "addon.node";
  for (const file of [entry, addon]) writeFileSync(join(helperRoot, file), file);
  const sha256 = (file) => createHash("sha256").update(file).digest("hex");
  writeFileSync(
    join(helperRoot, "runtime-manifest.json"),
    JSON.stringify({ entry, addon, sha256: { entry: sha256(entry), addon: sha256(addon) } }),
  );
  return resourcesDir;
}

test("win32：插件 node_modules 无 koffi（R18 携带策略）→ 校验通过（koffi 断言不再生效）", () => {
  const errors = verifyCuaPluginAssets({
    resourcesDir: buildResources(),
    targetPlatform: { os: "win32", arch: "x64" },
  });
  assert.deepEqual(errors, []);
});

test("darwin：缺 koffi → 报 missing staged koffi runtime（携带策略要求在场）", () => {
  const errors = verifyCuaPluginAssets({
    resourcesDir: buildResources(),
    targetPlatform: { os: "darwin", arch: "arm64" },
  });
  assert.equal(errors.filter((error) => error.includes("missing staged koffi runtime for darwin_arm64")).length, 1);
});

test("darwin：koffi 在位（index.js + darwin_arm64/koffi.node）→ 无 koffi 错误（R19：同分支还要求 mac Helper.app，fixture 全量 staged）", () => {
  const errors = verifyCuaPluginAssets({
    resourcesDir: buildResources({ withKoffi: true, withMacHelper: true }),
    targetPlatform: { os: "darwin", arch: "arm64" },
  });
  assert.deepEqual(errors, []);
});

test("win32：sharp 链缺失仍必须报错（放宽的只有 koffi，不是整段校验）", () => {
  const resourcesDir = mkdtempSync(join(tmpdir(), "koffi-assets-verify-"));
  const errors = verifyCuaPluginAssets({
    resourcesDir,
    targetPlatform: { os: "win32", arch: "x64" },
  });
  assert.ok(errors.some((error) => error.includes("missing staged sharp runtime")));
});
