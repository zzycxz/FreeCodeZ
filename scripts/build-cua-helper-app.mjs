#!/usr/bin/env node
// ============================================================
// R19（mac Helper 自研产线）：FreeCodeZ Computer Use.app 装配脚本
// ============================================================
// 产物：packages/desktop/dist-cua-helper/FreeCodeZ Computer Use.app
//   Contents/MacOS/FreeCodeZ Computer Use   ← node 底座直拷（构建机 process.execPath，
//     CFBundleExecutable=真 Mach-O 保 TCC bundle 归属；SEA 基座方案已废弃）
//   Contents/Resources/dist/helper-main.mjs ← esbuild 打包 packages/zcode-cua/macos/helper-main.js
//   Contents/Resources/node_modules/koffi/  ← 自根 node_modules 携带，按目标平台裁剪
//   Contents/Resources/AppIcon.icns          ← 复用桌面图标
//   Contents/Info.plist                      ← 身份键 app.freecodez.cua-helper（R20，TCC 独立行）
//   identity.json                            ← 安装验签锚（createCuaHelperInstaller 读取）
// 最后 adhoc 签名（codesign -f -s -，verify 通过；FC 无 Developer ID 体系）。
// electron-builder extraResources 将 dist-cua-helper → resources/cua-helper（同 win32
// tools/cua-helper 先例）；afterPack verifyCuaPluginAssets darwin 分支断言在场。
//
// 非 darwin 目标平台 exit 0 跳过（win32 走 vendored helper，linux 无执行层）；
// darwin 目标但非 darwin 构建机 exit 1（node 底座 arch 与 codesign 均不可用）。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEV_CUA_HELPER_BUNDLE_ID,
  DEV_HELPER_APP_NAME,
  HELPER_APP_NAME,
  HELPER_BUNDLE_ID,
} from "../packages/zcode-cua/broker-helper-constants.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// node 底座必须是「自包含单文件」二进制：Homebrew 的 node 是依赖 libnode.dylib + 一串
// brew 库的 stub（otool -L 可见 /opt/homebrew 依赖），拷进 .app 独立跑不起来；官方
// nodejs.org 分发版是自包含的。版本与 mise.toml 同源（esbuild target=node24 同基线）。
const NODE_DIST_VERSION = "24.14.0";
const NODE_DIST_MIRROR_DEFAULT = "https://registry.npmmirror.com/-/binary/node";
const NODE_BASE_CACHE_ROOT = join(repoRoot, ".tmp", "cua-helper-node");

const HELPER_ENTRY_SOURCE = join(repoRoot, "packages", "zcode-cua", "macos", "helper-main.js");
const KOFFI_SOURCE = join(repoRoot, "node_modules", "koffi");
const DESKTOP_ICON = join(repoRoot, "packages", "desktop", "build", "icon.icns");
const DEFAULT_OUTPUT_DIR = join(repoRoot, "packages", "desktop", "dist-cua-helper");
const USAGE_DESCRIPTION =
  "FreeCodeZ Computer Use needs to control System Events to activate target apps for computer use.";

function nodeBinaryDeps(binaryPath) {
  const result = spawnSync("/usr/bin/otool", ["-L", binaryPath], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(" ")[0]);
}

/** 自包含判定：动态库依赖只允许系统路径（/usr/lib、/System）——Homebrew stub 会被拒。 */
function isSelfContainedNodeBinary(binaryPath) {
  const deps = nodeBinaryDeps(binaryPath);
  if (!deps) return false;
  return deps.every((dep) => dep.startsWith("/usr/lib/") || dep.startsWith("/System/"));
}

function nodeVersionOf(binaryPath) {
  const result = spawnSync(binaryPath, ["--version"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function downloadNodeBase(targetArch) {
  const distArch = targetArch === "x64" ? "x64" : "arm64";
  const dirName = `node-v${NODE_DIST_VERSION}-darwin-${distArch}`;
  const cacheBinary = join(NODE_BASE_CACHE_ROOT, dirName, "bin", "node");
  if (existsSync(cacheBinary) && nodeVersionOf(cacheBinary) === `v${NODE_DIST_VERSION}`) {
    return cacheBinary;
  }
  const mirror = process.env.FREECODEZ_NODE_DIST_MIRROR ?? NODE_DIST_MIRROR_DEFAULT;
  const url = `${mirror}/v${NODE_DIST_VERSION}/${dirName}.tar.gz`;
  console.log(`[build-cua-helper-app] 下载自包含 node 底座: ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`node 底座下载失败 HTTP ${response.status}（可用 FREECODEZ_NODE_DIST_MIRROR 换源）: ${url}`);
  }
  const archive = Buffer.from(await response.arrayBuffer());
  mkdirSync(NODE_BASE_CACHE_ROOT, { recursive: true });
  const archivePath = join(NODE_BASE_CACHE_ROOT, `${dirName}.tar.gz`);
  writeFileSync(archivePath, archive);
  const extract = spawnSync("/usr/bin/tar", ["-xzf", archivePath, "-C", NODE_BASE_CACHE_ROOT], {
    encoding: "utf8",
  });
  if (extract.status !== 0 || !existsSync(cacheBinary)) {
    throw new Error(`node 底座解压失败: ${extract.stderr ?? cacheBinary}`);
  }
  chmodSync(cacheBinary, 0o755);
  return cacheBinary;
}

/** 底座解析链：显式 env → /.tmp 缓存 → process.execPath（自包含才可用）→ 镜像下载。 */
async function resolveNodeBase(targetArch) {
  const explicit = process.env.FREECODEZ_CUA_HELPER_NODE_BASE?.trim();
  if (explicit && existsSync(explicit) && nodeVersionOf(explicit)) {
    return { path: explicit, source: "env" };
  }
  const distArch = targetArch === "x64" ? "x64" : "arm64";
  const cacheBinary = join(
    NODE_BASE_CACHE_ROOT,
    `node-v${NODE_DIST_VERSION}-darwin-${distArch}`,
    "bin",
    "node",
  );
  if (existsSync(cacheBinary) && nodeVersionOf(cacheBinary) === `v${NODE_DIST_VERSION}`) {
    return { path: cacheBinary, source: "cache" };
  }
  if (isSelfContainedNodeBinary(process.execPath) && nodeVersionOf(process.execPath)) {
    return { path: process.execPath, source: "process.execPath" };
  }
  return { path: await downloadNodeBase(targetArch), source: "download" };
}

// 与 bundle.mjs osAliasMap 同口径：mac/macos/osx/darwin 统称 darwin（bundle.mjs 的
// ZCODE_TARGET_OS 传的是构建器别名 "mac"）。
const OS_ALIASES = new Map([
  ["mac", "darwin"],
  ["macos", "darwin"],
  ["osx", "darwin"],
  ["darwin", "darwin"],
]);

function normalizeTargetOs(value) {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return OS_ALIASES.get(key) ?? (key || null);
}

function parseScriptArgs(argv) {
  const options = {
    os: process.env.FREECODEZ_TARGET_OS ?? process.env.ZCODE_TARGET_OS ?? process.platform,
    arch: process.env.FREECODEZ_TARGET_ARCH ?? process.env.ZCODE_TARGET_ARCH,
    dev: false,
    sign: true,
    outDir: DEFAULT_OUTPUT_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dev") options.dev = true;
    else if (token === "--skip-sign") options.sign = false;
    else if (token === "--os") options.os = argv[(index += 1)];
    else if (token === "--arch") options.arch = argv[(index += 1)];
    else if (token === "--out") options.outDir = argv[(index += 1)];
  }
  options.os = normalizeTargetOs(options.os) ?? "darwin";
  options.arch ??= "arm64";
  return options;
}

/** 与 ZCode 官方 Helper Info.plist 键集对齐（锚点族冻结；buildId 落 identity.json 不入 plist）。 */
export function buildHelperInfoPlist({ executableName, bundleId, version }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>${executableName}</string>
	<key>CFBundleExecutable</key>
	<string>${executableName}</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>CFBundleIdentifier</key>
	<string>${bundleId}</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>${executableName}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>${version}</string>
	<key>CFBundleVersion</key>
	<string>${version}</string>
	<key>LSMinimumSystemVersion</key>
	<string>12.0</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSAppleEventsUsageDescription</key>
	<string>${USAGE_DESCRIPTION}</string>
</dict>
</plist>
`;
}

/** 安装验签锚：createCuaHelperInstaller.readBundleIdentityManifest 只强制 bundleId。 */
export function buildHelperIdentityJson({ bundleId, displayName, executableName, version, buildId }) {
  return `${JSON.stringify({ schemaVersion: 1, bundleId, displayName, executable: executableName, version, buildId }, null, 2)}\n`;
}

/** koffi 裁剪：只保留 build/koffi/<os>_<arch>（R18 同策略；全平台集合有 ~210MB 死重）。 */
export function pruneKoffiToTargetPlatform(koffiRoot, targetOs, targetArch) {
  const buildKoffi = join(koffiRoot, "build", "koffi");
  const keep = `${targetOs}_${targetArch}`;
  if (!existsSync(join(buildKoffi, keep))) {
    throw new Error(`koffi prebuilt for ${keep} not found under ${buildKoffi}`);
  }
  for (const entry of readdirSync(buildKoffi)) {
    if (entry !== keep) rmSync(join(buildKoffi, entry), { recursive: true, force: true });
  }
}

function sha256FileSync(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fileSizeMB(path) {
  return (statSync(path).size / (1024 * 1024)).toFixed(1);
}

async function bundleHelperEntry(outfile, { targetOs, targetArch }) {
  const esbuild = await import("esbuild");
  await esbuild.build({
    entryPoints: [HELPER_ENTRY_SOURCE],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["koffi"],
    minify: false,
    sourcemap: false,
    logLevel: "warning",
    metafile: false,
    // 打包守卫：产物必须可被「node <bundle> --socket …」直跑（平台元数据仅注释用途）。
    banner: { js: `/* FreeCodeZ Computer Use helper bundle (target ${targetOs}_${targetArch}) */` },
  });
}

async function main() {
  const options = parseScriptArgs(process.argv.slice(2));
  if (process.env.FREECODEZ_CUA_HELPER_SKIP === "1") {
    console.log("[build-cua-helper-app] skipped (FREECODEZ_CUA_HELPER_SKIP=1)");
    return;
  }
  if (options.os !== "darwin") {
    console.log(`[build-cua-helper-app] skipped (target os=${options.os}; mac Helper 仅 darwin 携带)`);
    return;
  }
  if (process.platform !== "darwin") {
    console.error(
      "[build-cua-helper-app] darwin 目标需要 darwin 构建机（node 底座 arch 与 codesign 均绑定宿主），拒绝产出错误架构产物",
    );
    process.exitCode = 1;
    return;
  }
  const desktopVersion =
    JSON.parse(readFileSync(join(repoRoot, "packages", "desktop", "package.json"), "utf8")).version ??
    JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
  const { resolveCuaHelperBuildId } = await import("./cua-helper-build-id.mjs");
  const buildId = resolveCuaHelperBuildId(process.env);
  const appName = options.dev ? DEV_HELPER_APP_NAME : HELPER_APP_NAME;
  const bundleId = options.dev ? DEV_CUA_HELPER_BUNDLE_ID : HELPER_BUNDLE_ID;
  const executableName = appName.replace(/\.app$/, "");

  if (!existsSync(HELPER_ENTRY_SOURCE)) {
    console.error(`[build-cua-helper-app] helper entry source missing: ${HELPER_ENTRY_SOURCE}`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(KOFFI_SOURCE)) {
    console.error(`[build-cua-helper-app] koffi not resolvable at ${KOFFI_SOURCE}（先 pnpm install）`);
    process.exitCode = 1;
    return;
  }

  const appDir = join(options.outDir, appName);
  const contentsDir = join(appDir, "Contents");
  const macosDir = join(contentsDir, "MacOS");
  const resourcesDir = join(contentsDir, "Resources");
  const distDir = join(resourcesDir, "dist");
  rmSync(join(options.outDir), { recursive: true, force: true });
  mkdirSync(macosDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  mkdirSync(join(resourcesDir, "node_modules"), { recursive: true });

  // 1) helper 入口 bundle（koffi external，运行时自 Resources/node_modules 解析）。
  const entryOut = join(distDir, "helper-main.mjs");
  await bundleHelperEntry(entryOut, options);

  // 2) node 底座：CFBundleExecutable 必须是束内真 Mach-O，TCC 才归因到 Helper；
  //    且必须自包含（Homebrew stub 依赖外部 dylib，拷进去起不来）。
  const nodeBase = await resolveNodeBase(options.arch);
  const executableOut = join(macosDir, executableName);
  cpSync(nodeBase.path, executableOut, { dereference: true });
  chmodSync(executableOut, 0o755);

  // 3) koffi 原生运行时（symlink 解引用 + 平台裁剪）。
  cpSync(KOFFI_SOURCE, join(resourcesDir, "node_modules", "koffi"), { dereference: true, recursive: true });
  pruneKoffiToTargetPlatform(join(resourcesDir, "node_modules", "koffi"), options.os, options.arch);

  // 4) 图标 / Info.plist / identity.json。
  cpSync(DESKTOP_ICON, join(resourcesDir, "AppIcon.icns"));
  writeFileSync(
    join(contentsDir, "Info.plist"),
    buildHelperInfoPlist({ executableName, bundleId, version: desktopVersion }),
  );
  writeFileSync(
    join(resourcesDir, "identity.json"),
    buildHelperIdentityJson({
      bundleId,
      displayName: executableName,
      executableName,
      version: desktopVersion,
      buildId,
    }),
  );

  // 5) adhoc 签名：无身份签名但结构有效（codesign --verify 通过），本地分发/手动 TCC 授权够用。
  if (options.sign) {
    const signResult = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", appDir], {
      encoding: "utf8",
    });
    if (signResult.status !== 0) {
      console.error(`[build-cua-helper-app] adhoc codesign failed: ${signResult.stderr ?? ""}`);
      process.exitCode = 1;
      return;
    }
  }

  const koffiNode = readdirSync(join(resourcesDir, "node_modules", "koffi", "build", "koffi")).flatMap(
    (entry) => readdirSync(join(resourcesDir, "node_modules", "koffi", "build", "koffi", entry)).map(
      (file) => join(resourcesDir, "node_modules", "koffi", "build", "koffi", entry, file),
    ),
  )[0];
  console.log(
    [
      "[build-cua-helper-app] 完成",
      `  app        ${appDir}`,
      `  executable ${executableOut} (${fileSizeMB(executableOut)} MB, node=${nodeVersionOf(executableOut) ?? "?"} via ${nodeBase.source}, sha256=${sha256FileSync(executableOut).slice(0, 16)}…)`,
      `  entry      ${entryOut} (${fileSizeMB(entryOut)} MB, sha256=${sha256FileSync(entryOut).slice(0, 16)}…)`,
      `  koffi.node ${koffiNode} (${fileSizeMB(koffiNode)} MB, sha256=${sha256FileSync(koffiNode).slice(0, 16)}…)`,
      `  identity   bundleId=${bundleId} version=${desktopVersion} buildId=${buildId} sign=${options.sign ? "adhoc" : "none"}`,
    ].join("\n"),
  );
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  await main();
}
