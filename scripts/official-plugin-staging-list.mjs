// 内置插件打包 stage 清单（唯一事实源）。
// 消费方：scripts/prepare-prebuilds.mjs（远端 shared-host 预构建）、
// packages/desktop/scripts/prepare-agent-node-bundle.mjs（桌面生产打包）、
// packages/services/test/pluginMarketplaceParity.test.ts（C3 机械一致性断言）。
//
// C3（docs/spec/plugin-marketplace-parity.md §6）：条目与
// apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts 的 definitions
// 一一对应（stagedPath ↔ rootCandidates 首项、包内 .zcode-plugin/plugin.json 版本 ↔
// definition.version、definition.requiredSeedPaths 逐条在场）。
// 历史教训：平行清单各改各的，曾因「删源漏改清单」（上游 44b25ed46c）让远端预构建与桌面
// 打包先后以 missing runtime 挂掉；故收敛为本模块 + 机械对照测试，禁止再复制第三份。
//
// computer-use（zcode-cua-plugin）暂缺条目：其 runtime 依赖 koffi/sharp 原生包，而
// node_modules 不在 stage 白名单内，启用即断；就绪后按同形状补条目（spec §10 决策）。
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const BROWSER_USE_PLUGIN_PACKAGE_NAME = "@zcode/browser-use-plugin";

// node_repl 宿主抽成独立包后，browser-use 只带自己的 client script 与 skill/docs。
// remote prebuild 与桌面 seed 使用同一录屏文档完整性合同（docs/recording.md 不可缺）。
export const browserUseRequiredRuntimePaths = [
  "scripts/browser-client.mjs",
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  "docs/recording.md",
  "docs/workflow.md",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
];

export const officialPluginStagingList = [
  {
    // browser-use 只携带自己的 client script 与 skill/docs；node_repl MCP runtime 归
    // @zcode/node-repl-host（见下一个条目）。
    packageName: BROWSER_USE_PLUGIN_PACKAGE_NAME,
    relativePath: "apps/zcode-cli/packages/browser-use-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: browserUseRequiredRuntimePaths,
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/browser-use-plugin",
  },
  {
    // node_repl 宿主：Browser Use 与 Computer Use 共用的 MCP runtime。它没有 listing
    // （不进插件市场展示面），但生产包首启 seed 必须拿到它的 dist runtime，否则
    // bua/cua 任一开启时都会连不上 node_repl。
    packageName: "@zcode/node-repl-host",
    relativePath: "apps/zcode-cli/packages/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/node-repl-host",
  },
  // —— 内容/工具插件：无 runtime 构建，只 stage 文件 ——
  {
    packageName: "@zcode/android-emulator-plugin",
    relativePath: "apps/zcode-cli/packages/android-emulator-plugin",
    requiresRuntime: false,
    stagedPath: "packages/android-emulator-plugin",
  },
  {
    packageName: "@zcode/documents-plugin",
    relativePath: "apps/zcode-cli/packages/documents-plugin",
    requiresRuntime: false,
    stagedPath: "packages/documents-plugin",
  },
  {
    packageName: "@zcode/pdf-plugin",
    relativePath: "apps/zcode-cli/packages/pdf-plugin",
    requiresRuntime: false,
    stagedPath: "packages/pdf-plugin",
  },
  {
    packageName: "@zcode/presentations-plugin",
    relativePath: "apps/zcode-cli/packages/presentations-plugin",
    requiresRuntime: false,
    stagedPath: "packages/presentations-plugin",
  },
  {
    packageName: "@zcode/spreadsheets-plugin",
    relativePath: "apps/zcode-cli/packages/spreadsheets-plugin",
    requiresRuntime: false,
    stagedPath: "packages/spreadsheets-plugin",
  },
  {
    packageName: "@zcode/ios-simulator-plugin",
    relativePath: "apps/zcode-cli/packages/ios-simulator-plugin",
    requiresRuntime: false,
    stagedPath: "packages/ios-simulator-plugin",
  },
  {
    packageName: "@zcode/restore-legacy-sessions-plugin",
    relativePath: "apps/zcode-cli/packages/restore-legacy-sessions-plugin",
    requiresRuntime: false,
    stagedPath: "packages/restore-legacy-sessions-plugin",
  },
  {
    packageName: "@zcode/plugin-creator-plugin",
    relativePath: "apps/zcode-cli/packages/plugin-creator-plugin",
    requiresRuntime: false,
    stagedPath: "packages/plugin-creator-plugin",
  },
  {
    packageName: "@zcode/skill-creator-plugin",
    relativePath: "apps/zcode-cli/packages/skill-creator-plugin",
    requiresRuntime: false,
    stagedPath: "packages/skill-creator-plugin",
  },
  {
    packageName: "@zcode/zcode-guide-plugin",
    relativePath: "apps/zcode-cli/packages/zcode-guide-plugin",
    requiresRuntime: false,
    stagedPath: "packages/zcode-guide-plugin",
  },
];

/** C3 构建期断言：清单指向的包体与 manifest 必须在场，缺一即失败（防「删源漏改」复发）。 */
export function assertOfficialPluginSourcesExist(repoRoot) {
  for (const plugin of officialPluginStagingList) {
    const manifestPath = resolve(repoRoot, plugin.relativePath, ".zcode-plugin", "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`missing official plugin manifest: ${manifestPath}`);
    }
  }
}
