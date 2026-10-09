#!/usr/bin/env node

import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNativeSearchReleasePlan } from "../../../scripts/native-search-tools-config.mjs";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { getTargetPlatform } from "./target-platform.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const target = getTargetPlatform();
const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
  platform: target.os,
  arch: target.arch,
});
// Windows Chrome 导入入口未启用，默认构建继续编译 helper 会增加 CI 时间和发布签名面。
// 保留显式开关，后续恢复入口时仍可复用既有原生实现和供应链校验。
const shouldPrepareWindowsBrowserImportHelper =
  target.os === "win32" && (process.env.FREECODEZ_ENABLE_WINDOWS_BROWSER_IMPORT ?? process.env.ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT) === "1";
// CUA 权限浮窗的吸附数据源。仅 macOS；缺 swiftc 时脚本内部自行降级为跳过（浮窗 fail-open
// 到屏幕底部，仍可用），所以无条件挂在 darwin 上不会让构建变脆。
const shouldPrepareMacosWindowBounds = target.os === "darwin";
// R19（mac Helper 自研产线）：FreeCodeZ Computer Use.app 装配（esbuild+node 底座+koffi 裁剪
// +adhoc 签名）。仅 darwin；脚本内部对非 darwin 目标 exit 0 跳过、对 darwin 目标非 darwin
// 构建机 exit 1（产物缺它会被 afterPack verifyCuaPluginAssets 拒绝，所以这里必须真产出）。
const shouldPrepareMacCuaHelper = target.os === "darwin";

// 本机桌面包内置 agent 的 JS bundle（prepare:agent-bundle），运行时由 app 的 Electron Node runtime 执行。
// 远端跨平台原生二进制仍由上面的 prepare:remote-assets 提供。
// native-search 归档随仓库分发，准备步骤只做本地解包校验，不需要任何下载源配置。
const localRuntimeScripts = [
  "prepare:agent-bundle",
  ...(nativeSearchReleasePlan.enabled ? ["prepare:native-search"] : []),
  ...(shouldPrepareWindowsBrowserImportHelper ? ["prepare:browser-import-helper"] : []),
  ...(shouldPrepareMacosWindowBounds ? ["prepare:macos-window-bounds"] : []),
  ...(shouldPrepareMacCuaHelper ? ["prepare:cua-helper"] : []),
];

function runTimedPnpmScript(scriptName) {
  const startMs = Date.now();
  console.log(`[ci][timer] prepare-runtime-assets:${scriptName} start`);
  try {
    runCommand(pnpmCommand, [scriptName], {
      cwd: desktopRoot,
      env: process.env,
    });
  } finally {
    console.log(
      `[ci][timer] prepare-runtime-assets:${scriptName} end duration_ms=${Date.now() - startMs}`,
    );
  }
}

const shouldSkipRemoteAssets = (process.env.FREECODEZ_SKIP_REMOTE_ASSETS ?? process.env.ZCODE_SKIP_REMOTE_ASSETS) === "1";

if (!shouldSkipRemoteAssets) {
  runTimedPnpmScript("prepare:remote-assets");
} else {
  // Windows build job 的桌面安装包不依赖 mock-cdn remote 资产。
  // 之前这里无条件执行 prepare:remote-assets，会在同一个 job 里串行下载/打包跨平台资源，
  // 导致 CI 时间被白白拉长并逼近 1 小时上限。增加显式开关，只在需要时才准备 remote 资产。
  console.log("[prepare:runtime-assets] skip prepare:remote-assets (ZCODE_SKIP_REMOTE_ASSETS=1)");
}

for (const scriptName of localRuntimeScripts) {
  runTimedPnpmScript(scriptName);
}
