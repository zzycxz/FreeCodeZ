#!/usr/bin/env node

// 桌面打包态的 agent 运行时资产：把 agent 的 JS bundle（zcode.cjs）放进 bundled-agents/<platform>/glm，
// 由 app 内置的 Electron Node runtime（ELECTRON_RUN_AS_NODE）执行，替代以前随包内置的独立 Node 二进制。
//
// 为什么这么做：
// - agent 没有任何原生 NAPI 插件（ripgrep 是 WASM，其余纯 JS），可直接跑在 Electron 的 Node 上；
// - Electron 41 内置 Node 24.x，与 zcode-cli 的目标运行时一致；
// - 单平台体积从 ~180MB 降到 ~16MB，且同一份 JS 跨平台通用；
// - app-server 命令路径不会加载 @zcode/tui，所以这里天然不打包 TUI。
//
// 远端（SSH/WSL/Docker）没有 Electron，仍走 prepare:remote-assets 的原生二进制，互不影响。

import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { resolveCuaHelperBuildId } from "../../../scripts/cua-helper-build-id.mjs";
import {
  assertOfficialPluginSourcesExist,
  BROWSER_USE_PLUGIN_PACKAGE_NAME,
  officialPluginStagingList,
} from "../../../scripts/official-plugin-staging-list.mjs";
import { stageAgentBundle } from "./stage-agent-bundle.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const cliBundlePath = resolve(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
const adaptersRoot = resolve(repoRoot, "apps/zcode-cli/packages/adapters");
const pnpmRunEnv = {
  ...process.env,
  // 电脑控制能力补位(B1-6):Helper 验签锚点同源注入(见 scripts/cua-helper-build-id.mjs)。
  ZCODE_CUA_HELPER_BUILD_ID: resolveCuaHelperBuildId(process.env),
  // pnpm 11 会在 apps/zcode-cli 子 workspace 执行 run 前触发 install；
  // 子 workspace 不能解析根 workspace 的 @zcode/shared，Docker/web app 打包会因此卡在插件 runtime 构建。
  PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
};
// BROWSER_USE_PLUGIN_PACKAGE_NAME 与 stage 清单同源于 scripts/official-plugin-staging-list.mjs。

// 平台目录命名：darwin/win32/linux + x64/arm64，
// 支持 ZCODE_TARGET_OS / ZCODE_TARGET_ARCH 覆盖（交叉打包时由 CI 注入）。
function normalizePlatform(raw) {
  switch (raw) {
    case "mac":
    case "macos":
    case "darwin":
    case "osx":
      return "darwin";
    case "win":
    case "windows":
    case "win32":
      return "win32";
    case "linux":
      return "linux";
    default:
      return raw;
  }
}

function normalizeArch(raw) {
  switch (raw) {
    case "x86_64":
    case "x64":
    case "amd64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return raw;
  }
}

const platform = normalizePlatform((process.env.FREECODEZ_TARGET_OS ?? process.env.ZCODE_TARGET_OS) || "") || process.platform;
const arch = normalizeArch((process.env.FREECODEZ_TARGET_ARCH ?? process.env.ZCODE_TARGET_ARCH) || "") || process.arch;
const platformKey = `${platform}-${arch}`;

const glmDir = resolve(desktopRoot, "bundled-agents", platformKey, "glm");
// zcode.cjs / .node-bundle-meta.json 的落点由 stage-agent-bundle.mjs 自己解析（同源）。
// 内置插件 stage 清单已收敛为单一事实源 scripts/official-plugin-staging-list.mjs。
// 历史教训：两份平行清单各改各的，missing runtime 挂掉两次；C3 机械对照见
// packages/services/test/pluginMarketplaceParity.test.ts，权威归属见
// bootstrap/official-plugin-definitions.ts。
const officialPluginPackages = officialPluginStagingList;
const includedOfficialPluginTopLevelPaths = new Set([
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // Electron 生产资源复制有独立白名单，遗漏 agents 会让首启 filesystem seed 永久缺少子代理。
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  "scripts",
  "skills",
  "templates",
]);
const excludedOfficialPluginAssetNames = new Set([
  ".DS_Store",
  ".venv",
  "__pycache__",
  "node_modules",
]);
// CUA 插件的 node_modules 白名单（B1-3）：koffi/sharp 链是 runtime 依赖，整体过滤必丢，
// 携带集=official-plugin-staging-list.mjs 的 carriedNodeModules。三平台各取所需
// （2026-10-07 R18 推广，「打哪个平台带哪个平台的库」）：
// - win32：vendored 源（本就是 win32_x64 单平台形态，SHA256SUMS 管理）；
// - darwin/linux：构建机 workspace 源（hoisted 布局含全平台 optional 产物，复制后按
//   目标平台+架构裁剪）。koffi 仅 darwin 携带——FC 的 koffi 执行层调 macOS AX API
//   （koffi-ax.js），linux 无该框架、win32 走 vendored helper addon，带了对它们是死重。
// semver/detect-libc 为纯 JS，各平台都从 vendored 源取。
// 非 win32 目标下改从 workspace（构建机依赖根）解析的原生包。
const WORKSPACE_NATIVE_CARRIES = new Set(["koffi", "sharp"]);

function shouldCopyOfficialPluginAsset(sourcePath) {
  const name = basename(sourcePath);
  return !excludedOfficialPluginAssetNames.has(name) && !name.endsWith(".pyc");
}

// sharp 的平台二进制包（@img/sharp-darwin-arm64 等）：本仓 pnpm 为 hoisted 布局时在
// node_modules/@img 顶层；防御性兜底走 sharp 实体的 .pnpm 邻域推导。
function resolveWorkspaceImgSource(workspaceNodeModules) {
  const topLevel = resolve(workspaceNodeModules, "@img");
  if (existsSync(topLevel)) return topLevel;
  const sharpReal = realpathSync(resolve(workspaceNodeModules, "sharp"));
  return resolve(sharpReal, "..", "@img");
}

function carriedNodeModuleSource(name, sourceRoot) {
  if (platform !== "win32" && WORKSPACE_NATIVE_CARRIES.has(name)) {
    const workspaceNodeModules = resolve(repoRoot, "node_modules");
    if (name === "@img") return resolveWorkspaceImgSource(workspaceNodeModules);
    return resolve(workspaceNodeModules, ...name.split("/"));
  }
  return resolve(sourceRoot, "node_modules", ...name.split("/"));
}

// 平台差异携带集：koffi 仅 darwin（win32 有 vendored addon、linux 无 AX 执行层）。
function carriedNodeModuleNames(plugin) {
  if (platform === "darwin") return plugin.carriedNodeModules;
  return plugin.carriedNodeModules.filter((name) => name !== "koffi");
}

// R18 瘦身：workspace 的 hoisted 布局把 @img/koffi 的全部平台二进制都装了（pnpm optional
// 全平台产物），照单携带给单平台包带来 ~210MB 死重（libvips 每平台 15-19MB、koffi 每平台
// ~2.2MB）。复制后按目标平台+架构裁剪：@img 只留 colour + sharp[-libvips]-<platform>-<arch>；
// koffi 只留 build/koffi/<platform>_<arch>。win32 不经此函数（vendored 源本就是单平台形态）。
// linux 的 musl 变体（Alpine 系 sharp-libvips-linuxmusl-*）暂不携带——glibc 主流发行版
// 之外属后续按需项。
function pruneCarriedNativeToTargetArch(targetNodeModules) {
  if (platform === "win32") return;
  const imgDir = resolve(targetNodeModules, "@img");
  if (existsSync(imgDir)) {
    const keep = new Set(["colour", `sharp-${platform}-${arch}`, `sharp-libvips-${platform}-${arch}`]);
    for (const entry of readdirSync(imgDir)) {
      if (!keep.has(entry)) rmSync(resolve(imgDir, entry), { recursive: true, force: true });
    }
  }
  const koffiPlatforms = resolve(targetNodeModules, "koffi", "build", "koffi");
  if (existsSync(koffiPlatforms)) {
    const keepDir = `${platform}_${arch}`;
    for (const entry of readdirSync(koffiPlatforms)) {
      if (entry !== keepDir) rmSync(resolve(koffiPlatforms, entry), { recursive: true, force: true });
    }
  }
}

function stageCarriedNodeModules(plugin, sourceRoot, targetRoot) {
  // B1-3:白名单内的 node_modules 随 CUA 插件携带(koffi/sharp 链是 runtime 依赖);
  // 三平台各取所需：win32=vendored 形态；darwin/linux=构建机 workspace 形态+按平台裁剪（R18）。
  if (!plugin.carriedNodeModules) return;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") return;
  const targetNodeModules = resolve(targetRoot, "node_modules");
  for (const name of carriedNodeModuleNames(plugin)) {
    const from = carriedNodeModuleSource(name, sourceRoot);
    if (!existsSync(from)) continue;
    cpSync(from, resolve(targetNodeModules, ...name.split("/")), { recursive: true });
  }
  pruneCarriedNativeToTargetArch(targetNodeModules);
  // koffi 在位断言（B2 修复）：仅 darwin——唯一携带平台。必须 existsSync 查真实文件：
  // 旧写法 !shouldCarryCuaNodeModule(<koffi 路径>) 只查 basename 是否在白名单（恒为
  // "koffi"、恒在集合内），恒不触发；上游复制的 existsSync-continue 静默跳过时，出包缺
  // koffi 执行层无人拦截（2026-10-07 实证：目录缺失时断言表达式仍求值 false）。
  if (platform === "darwin") {
    const stagedKoffiNative = resolve(
      targetNodeModules,
      "koffi",
      "build",
      "koffi",
      `${platform}_${arch}`,
      "koffi.node",
    );
    if (!existsSync(stagedKoffiNative)) {
      throw new Error(`[prepare:agent-bundle] missing carried node module: ${stagedKoffiNative}`);
    }
  }
}

// staged node-repl-host 的 node_modules 运行时（R18）。两件事：
// ① darwin：server.ts captureComputerUseRuntimeFromEnvironment 的 koffi 进程内执行层
//   （packages/zcode-cua/macos/koffi-ax require("koffi")）从 server.js 向上解析
//   node_modules，二进制必须落在 node-repl-host/node_modules；
// ② 各平台：node_repl 会话内模型代码 require("sharp") 做截图/缩放处理——官方 glm 的
//   node-repl-host/node_modules 同构携带 sharp 链（@img/detect-libc/semver/sharp）。
// win32 维持原状不带（CUA 走 vendored helper addon；sharp 链的 win 携带属后续按需项）。
function stageNodeReplHostRuntime(targetRoot) {
  if (platform === "win32") return;
  const workspaceNodeModules = resolve(repoRoot, "node_modules");
  const vendoredCuaNodeModules = resolve(
    repoRoot,
    "apps/zcode-cli/dependencies/zcode-cua/plugin/node_modules",
  );
  const targetNodeModules = resolve(targetRoot, "node_modules");
  const sources = [
    ...(platform === "darwin"
      ? [["koffi", resolve(workspaceNodeModules, "koffi")]]
      : []),
    ["sharp", resolve(workspaceNodeModules, "sharp")],
    ["@img", resolveWorkspaceImgSource(workspaceNodeModules)],
    ["semver", resolve(vendoredCuaNodeModules, "semver")],
    ["detect-libc", resolve(vendoredCuaNodeModules, "detect-libc")],
  ];
  for (const [name, from] of sources) {
    if (!existsSync(from)) {
      throw new Error(`[prepare:agent-bundle] ${platform} node-repl-host carry missing: ${name} (${from})`);
    }
    cpSync(from, resolve(targetNodeModules, name), { recursive: true });
  }
  pruneCarriedNativeToTargetArch(targetNodeModules);
  console.log(`[prepare:agent-bundle] staged ${platform} runtime node_modules for ${targetRoot}`);
}
const isBootstrapWithRemote = (process.env.FREECODEZ_BOOTSTRAP_WITH_REMOTE ?? process.env.ZCODE_BOOTSTRAP_WITH_REMOTE) === "1";

function buildCliBundle() {
  console.log("[prepare:agent-bundle] building zcode-cli app-server bundle ...");
  // 复用仓库根脚本（turbo build:desktop-agent --filter=@zcode/cli），命中缓存时几乎瞬时。
  runCommand(process.execPath, [resolve(repoRoot, "scripts/build-desktop-agent-cli.mjs")], {
    cwd: repoRoot,
    env: pnpmRunEnv,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(
      `[prepare:agent-bundle] expected cli bundle missing after build: ${cliBundlePath}`,
    );
  }
}

function buildOfficialPluginRuntimes() {
  for (const plugin of officialPluginPackages) {
    if (!plugin.requiresRuntime) continue;
    console.log(`[prepare:agent-bundle] building ${plugin.packageName} runtime ...`);
    if (isBootstrapWithRemote) {
      buildOfficialPluginRuntimeForBootstrap(plugin);
      assertOfficialPluginRuntime(plugin);
      continue;
    }

    runCommand(
      "pnpm",
      ["--dir", resolve(repoRoot, "apps/zcode-cli"), "--filter", plugin.packageName, "build"],
      {
        cwd: repoRoot,
        env: pnpmRunEnv,
      },
    );
    assertOfficialPluginRuntime(plugin);
  }
}

function buildOfficialPluginRuntimeForBootstrap(plugin) {
  const pluginRoot = resolve(repoRoot, plugin.relativePath);
  const hasCompleteRuntime = plugin.requiredRuntimePaths.every((relativePath) =>
    existsSync(resolve(pluginRoot, ...relativePath.split("/"))),
  );
  if (plugin.packageName !== BROWSER_USE_PLUGIN_PACKAGE_NAME && hasCompleteRuntime) {
    console.log(
      `[prepare:agent-bundle] reuse existing official plugin runtime: ${plugin.packageName}`,
    );
    return;
  }

  // bootstrap:with-remote 会连续构建 remote assets 和桌面 agent bundle。
  // 通过 pnpm/filter 进入插件 build 时，tsc shim 在本地低内存环境中容易被 SIGKILL；
  // 这里仅在 bootstrap 开关下用当前 Node 直接执行等价 tsc + build-mcp，不改变插件自身 build 脚本。
  // browser-use 的 server 与 browser-client 是同一发布对；即使旧 server.js 存在也必须重建，
  // 否则会把旧 server 与当前 client（或缺失 client）一起 stage 到桌面安装包。
  runCommand(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
    cwd: pluginRoot,
    env: process.env,
  });
  runCommand(process.execPath, [plugin.runtimeBuildScript], {
    cwd: pluginRoot,
    env: process.env,
  });
}

function assertOfficialPluginRuntime(plugin) {
  const pluginRoot = resolve(repoRoot, plugin.relativePath);
  for (const relativePath of plugin.requiredRuntimePaths) {
    const runtimePath = resolve(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(runtimePath)) {
      throw new Error(`[prepare:agent-bundle] missing official plugin runtime: ${runtimePath}`);
    }
  }
}

function stageBundle() {
  // 实现已抽到 stage-agent-bundle.mjs：dev 链（scripts/build-desktop-agent-cli.mjs）
  // 必须用同一份，否则 dev 会继续跑上一次打包留下的陈旧 agent。
  stageAgentBundle({ repoRoot, platformKey });
}

function stageOfficialPlugins() {
  // C3 构建断言（A7）：清单 ↔ 包体在场校验，缺一即失败，防「删源漏改清单」复发。
  assertOfficialPluginSourcesExist(repoRoot);
  for (const plugin of officialPluginPackages) {
    const sourceRoot = resolve(repoRoot, plugin.relativePath);
    const manifestPath = resolve(sourceRoot, ".zcode-plugin", "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`[prepare:agent-bundle] missing official plugin manifest: ${manifestPath}`);
    }

    const targetRoot = resolve(glmDir, plugin.stagedPath);
    mkdirSync(targetRoot, { recursive: true });
    for (const entryName of includedOfficialPluginTopLevelPaths) {
      const sourcePath = resolve(sourceRoot, entryName);
      if (!existsSync(sourcePath)) continue;
      cpSync(sourcePath, resolve(targetRoot, entryName), {
        recursive: true,
        filter: shouldCopyOfficialPluginAsset,
      });
    }
    stageCarriedNodeModules(plugin, sourceRoot, targetRoot);
    // R18：node-repl-host 在 darwin/linux 下携带运行时（koffi 执行层+sharp 截图链，见函数注释）。
    if (plugin.stagedPath === "packages/node-repl-host") {
      stageNodeReplHostRuntime(targetRoot);
    }
    for (const relativePath of plugin.requiredSeedPaths ?? []) {
      const stagedAssetPath = resolve(targetRoot, ...relativePath.split("/"));
      if (!existsSync(stagedAssetPath)) {
        throw new Error(
          `[prepare:agent-bundle] missing staged official plugin seed asset: ${stagedAssetPath}`,
        );
      }
    }
    console.log(`[prepare:agent-bundle] staged official plugin ${plugin.stagedPath}`);
  }
}

// Electron 生产包只带 resources/glm/zcode.cjs 时，app-server 进程的
// __dirname 附近没有官方插件目录，启动时 seed 找不到 source，用户侧不会自动得到内置插件。
// 这里把官方插件按 bootstrap 的 rootCandidates 期望放到 glm/packages/*-plugin，
// 让 Electron Node 运行 zcode.cjs 时复用同一套 filesystem seed 逻辑。
// browser-use runtime 的声明生成依赖 @zcode/core/dist。CI 干净检出没有该产物，
// 必须先构建 CLI 依赖，再构建官方插件；开发机残留的 dist 曾掩盖这个顺序问题。
buildCliBundle();
buildOfficialPluginRuntimes();
stageBundle();
stageOfficialPlugins();
