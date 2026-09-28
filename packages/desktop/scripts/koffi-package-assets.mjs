// FreeCodeZ fork(电脑控制能力补位 B1-4):CUA 插件原生运行时的打包校验。
//
// 原 stageKoffiIntoBundledAgents 死代码已删除:koffi/sharp 链改由 CUA 插件的
// node_modules 白名单携带(official-plugin-staging-list.mjs 的 carriedNodeModules),
// 不再单独往 glm 根 staging——旧实现 stage/verify 目标路径不对称,是双份事实源。
// 本模块只保留 afterPack 用的完整性校验(缺一即打包失败,防「装上即断」)。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CUA_PLUGIN_STAGED_PATH = "packages/zcode-cua-plugin";

function koffiPlatformKey(targetPlatform) {
  return `${targetPlatform.os}_${targetPlatform.arch}`;
}

function sha256FileSync(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 校验打包产物里 CUA 资产完整性:
 *  - 插件 node_modules 的 koffi(index.js + 目标平台 koffi.node)与 sharp 在场;
 *  - resources/tools/cua-helper 的 runtime-manifest.json 与 entry/addon 字节哈希一致(R13)。
 * 返回错误字符串数组(空 = 通过)。
 */
export function verifyCuaPluginAssets({ resourcesDir, targetPlatform }) {
  const errors = [];
  const pluginRoot = join(resourcesDir, "glm", CUA_PLUGIN_STAGED_PATH);
  const platformKey = koffiPlatformKey(targetPlatform);

  const koffiRoot = join(pluginRoot, "node_modules", "koffi");
  const koffiNative = join(koffiRoot, "build", "koffi", platformKey, "koffi.node");
  if (!existsSync(join(koffiRoot, "index.js")) || !existsSync(koffiNative)) {
    errors.push(`missing staged koffi runtime for ${platformKey}: ${koffiNative}`);
  }
  if (!existsSync(join(pluginRoot, "node_modules", "sharp", "package.json"))) {
    errors.push(`missing staged sharp runtime: ${join(pluginRoot, "node_modules", "sharp")}`);
  }

  const helperRoot = join(resourcesDir, "tools", "cua-helper");
  // helper 运行时依赖缺席 = Helper 首次启用即断(2026-09-24 A16 实测的 extraResources 硬排除坑)。
  const helperSharp = join(helperRoot, "node_modules", "sharp", "package.json");
  if (!existsSync(helperSharp)) {
    errors.push(`missing helper runtime dependency: ${helperSharp}`);
  }
  const manifestPath = join(helperRoot, "runtime-manifest.json");
  if (!existsSync(manifestPath)) {
    errors.push(`missing CUA helper runtime manifest: ${manifestPath}`);
    return errors;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const key of ["entry", "addon"]) {
    const target = join(helperRoot, manifest[key]);
    if (!existsSync(target)) {
      errors.push(`missing CUA helper asset (${key}): ${target}`);
      continue;
    }
    const actual = sha256FileSync(target);
    if (actual !== manifest.sha256?.[key]) {
      errors.push(`CUA helper ${key} sha256 mismatch: ${actual} != ${manifest.sha256?.[key]}`);
    }
  }
  return errors;
}
