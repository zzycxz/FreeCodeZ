// FreeCodeZ fork(电脑控制能力补位 B1-4):CUA 插件原生运行时的打包校验。
//
// 原 stageKoffiIntoBundledAgents 死代码已删除:koffi/sharp 链改由 CUA 插件的
// node_modules 白名单携带(official-plugin-staging-list.mjs 的 carriedNodeModules),
// 不再单独往 glm 根 staging——旧实现 stage/verify 目标路径不对称,是双份事实源。
// 本模块只保留 afterPack 用的完整性校验(缺一即打包失败,防「装上即断」)。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HELPER_APP_NAME, HELPER_BUNDLE_ID } from "../../../packages/zcode-cua/broker-helper-constants.js";

const CUA_PLUGIN_STAGED_PATH = "packages/zcode-cua-plugin";

function koffiPlatformKey(targetPlatform) {
  return `${targetPlatform.os}_${targetPlatform.arch}`;
}

/**
 * afterPack 的 CUA 资产目录按平台取位：mac=appOutDir/<App>.app/Contents/Resources、
 * win=appOutDir/resources。抽成纯函数是因为 R19 首版在 config 里手写错了（用了 win 布局
 * 校验 mac，extraResources 明明拷对了却报全部缺失）；`framework.distMacOsAppName` 是常量
 * "Electron.app" 不能用来推导产物名，应用名必须取 packager.appInfo.productFilename。
 */
export function resolveCuaAssetsResourcesDir({ electronPlatformName, appOutDir, productFilename }) {
  return electronPlatformName === "darwin"
    ? join(appOutDir, `${productFilename}.app`, "Contents", "Resources")
    : join(appOutDir, "resources");
}

function sha256FileSync(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 校验打包产物里 CUA 资产完整性:
 *  - 插件 node_modules 的 koffi(仅 darwin 携带)与 sharp 在场;
 *  - darwin(R19): resources/cua-helper/FreeCodeZ Computer Use.app 结构在场
 *    (executable/entry/koffi.node/identity.json 且 bundleId 匹配冻结锚点);
 *  - win32: resources/tools/cua-helper 的 runtime-manifest.json 与 entry/addon 字节哈希一致(R13)。
 * 返回错误字符串数组(空 = 通过)。
 *
 * koffi 断言与 R18 携带策略同源(prepare-agent-node-bundle.mjs carriedNodeModuleNames):
 * koffi 仅 darwin 随插件携带——FC 的 koffi 执行层调 macOS AX API,win32 走 vendored helper
 * addon(tools/cua-helper)、linux 无该框架,插件 node_modules 里的 koffi 在非 darwin 平台
 * 没有消费方。修复背景(2026-10-07 端到端实证):本断言曾无条件要求 win32 koffi.node,与
 * staging 的平台过滤正面冲突——干净检出 win32 打包在 afterPack 必挂(missing staged
 * koffi runtime for win32_x64),开发机上 bundled-agents 旧残留会掩蔽该问题。
 */
export function verifyCuaPluginAssets({ resourcesDir, targetPlatform }) {
  const errors = [];
  const pluginRoot = join(resourcesDir, "glm", CUA_PLUGIN_STAGED_PATH);
  const platformKey = koffiPlatformKey(targetPlatform);

  if (targetPlatform.os === "darwin") {
    const koffiRoot = join(pluginRoot, "node_modules", "koffi");
    const koffiNative = join(koffiRoot, "build", "koffi", platformKey, "koffi.node");
    if (!existsSync(join(koffiRoot, "index.js")) || !existsSync(koffiNative)) {
      errors.push(`missing staged koffi runtime for ${platformKey}: ${koffiNative}`);
    }
    // R19 mac Helper 自研产线：结构缺失 = Helper 首启即断（宿主 resolveBundledCuaHelperAppPath
    // 拿到残缺 app 后 install/verify 必拒），必须在这里挡下。
    const helperApp = join(resourcesDir, "cua-helper", HELPER_APP_NAME);
    const helperExecutable = join(helperApp, "Contents", "MacOS", "FreeCodeZ Computer Use");
    if (!existsSync(helperExecutable)) {
      errors.push(`missing mac CUA helper executable: ${helperExecutable}`);
    }
    if (!existsSync(join(helperApp, "Contents", "Resources", "dist", "helper-main.mjs"))) {
      errors.push(`missing mac CUA helper entry: ${helperApp}`);
    }
    const helperKoffi = join(
      helperApp,
      "Contents",
      "Resources",
      "node_modules",
      "koffi",
      "build",
      "koffi",
      platformKey,
      "koffi.node",
    );
    if (!existsSync(helperKoffi)) {
      errors.push(`missing mac CUA helper koffi runtime for ${platformKey}: ${helperKoffi}`);
    }
    const identityPath = join(helperApp, "Contents", "Resources", "identity.json");
    let identityBundleId;
    try {
      identityBundleId = JSON.parse(readFileSync(identityPath, "utf8")).bundleId;
    } catch {
      identityBundleId = undefined;
    }
    if (identityBundleId !== HELPER_BUNDLE_ID) {
      errors.push(
        `mac CUA helper identity bundleId mismatch: expected ${HELPER_BUNDLE_ID}, found ${String(identityBundleId)} (${identityPath})`,
      );
    }
  }
  if (!existsSync(join(pluginRoot, "node_modules", "sharp", "package.json"))) {
    errors.push(`missing staged sharp runtime: ${join(pluginRoot, "node_modules", "sharp")}`);
  }

  if (targetPlatform.os === "win32") {
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
  }
  return errors;
}
