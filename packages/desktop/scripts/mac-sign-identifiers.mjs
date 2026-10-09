// R21（2026-10-08）：安装包身份自报——adhoc 复签钉签名标识。
// 背景：electron-builder 不签名（mac.identity=null，本地/未上 Developer ID 的打包路径）时，
// 产物沿用 Electron 模板的遗留签名标识（Identifier=Electron / Electron Helper），与
// app.freecodez.* 自报身份不符。签名标识是 TCC 责任进程归因、tccutil 定位与 Developer ID
// 迁移的锚点，必须与 bundle id 同族。命名惯例与官方 ZCode 实测同构：
// 主 app=<appId>；Helper 族=<appId>.helper[.GPU|Plugin|Renderer]（dev.zcode.app.helper.GPU）。
// 只在非 Developer ID 路径运行；Developer ID 签名由 electron-builder 签名阶段产出同值标识
// （官方 ZCode 产物实测 Identifier=dev.zcode.app 即其证据），彼时本步骤整体跳过。
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CODESIGN_PATH = "/usr/bin/codesign";

/**
 * Helper 束名 → 签名标识后缀。Electron 只产四形态；未知命名 fail-closed 抛错，
 * 防止新形态 helper 悄悄拿到错误身份进 TCC。
 */
export function helperSignIdentifier(appId, helperBundleName) {
  const known = new Map([
    ["Helper", `${appId}.helper`],
    ["Helper (GPU)", `${appId}.helper.GPU`],
    ["Helper (Plugin)", `${appId}.helper.Plugin`],
    ["Helper (Renderer)", `${appId}.helper.Renderer`],
  ]);
  const identifier = known.get(helperBundleName);
  if (!identifier) {
    throw new Error(`[mac-sign-identifiers] unexpected helper bundle name: ${helperBundleName}`);
  }
  return identifier;
}

/** 扫 Frameworks 下 <productFilename> Helper*.app，返回束名列表（字典序，供规划器排序）。 */
export function discoverHelperBundleNames(frameworksDir, productFilename) {
  if (!existsSync(frameworksDir)) return [];
  return readdirSync(frameworksDir)
    .filter((entry) => entry.startsWith(`${productFilename} Helper`) && entry.endsWith(".app"))
    .map((entry) => entry.slice(0, -".app".length))
    .sort();
}

/**
 * 产出有序签名计划：Helpers 先、主 app 最后（外层签名封内层，顺序不可反）。
 * entitlements 与 electron-builder 签名面一致（主 app 用 mac、Helper 用 inherit）。
 */
export function planMacAdhocSignIdentifiers({
  appBundlePath,
  helperBundleNames,
  appId,
  productFilename,
  entitlementsMain,
  entitlementsInherit,
}) {
  const steps = helperBundleNames.map((name) => {
    if (!name.startsWith(`${productFilename} `)) {
      throw new Error(`[mac-sign-identifiers] helper bundle outside product family: ${name}`);
    }
    return {
      targetPath: join(appBundlePath, "Contents", "Frameworks", `${name}.app`),
      identifier: helperSignIdentifier(appId, name.slice(productFilename.length + 1)),
      entitlements: entitlementsInherit,
    };
  });
  steps.push({
    targetPath: appBundlePath,
    identifier: appId,
    entitlements: entitlementsMain,
  });
  return steps;
}

/** 执行签名计划；runCommand 注入用（测试），缺省 spawnSync 原生 codesign。 */
export function applyMacAdhocSignIdentifiers(steps, runCommand) {
  const run =
    runCommand ??
    ((args) => {
      const result = spawnSync(CODESIGN_PATH, args, { encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(
          `[mac-sign-identifiers] codesign failed: ${result.stderr || result.stdout || `exit ${result.status}`}`,
        );
      }
    });
  for (const step of steps) {
    run([
      "--force",
      "--sign",
      "-",
      "--entitlements",
      step.entitlements,
      "--identifier",
      step.identifier,
      step.targetPath,
    ]);
  }
  return steps.length;
}
