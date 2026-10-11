import type { McpServerConfig, PluginLoadOutcome } from "@zcode/contracts";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createBundledMcpRuntimeConfig } from "./official-plugin-runtime.js";
import { withComputerEngineEnv } from "../mcp-config.js";
import {
  OFFICIAL_BROWSER_USE_PLUGIN_ID,
  OFFICIAL_NODE_REPL_HOST_PLUGIN_ID,
} from "./official-plugin-definitions.js";

const BUILT_IN_NODE_REPL_SERVER_NAME = "node_repl";

/** 引擎 sidecar dist 目录候选（纯函数，测试直测）。顺序=优先级：
 * ①打包态 app Resources 锚点（prepare-agent-node-bundle staging 布局）；
 * ②打包 staging 布局：插件根旁 computer-engine-dist（包未入缓存时兜底）；
 * ③开发态：workspace 同级引擎包 dist；
 * ④开发态：插件根（workspace 包路径）上溯到仓库 packages/computer-engine/dist。 */
export function computerEngineDistCandidates(input: {
  pluginRootPath: string;
  workingDirectory: string;
  resourcesPath?: string | undefined;
}): string[] {
  const packaged = input.resourcesPath
    ? [join(input.resourcesPath, "glm", "packages", "computer-engine-dist")]
    : [];
  return [
    ...packaged,
    resolve(input.pluginRootPath, "..", "computer-engine-dist"),
    resolve(input.workingDirectory, "..", "computer-engine", "dist"),
    resolve(input.pluginRootPath, "../../../../packages/computer-engine/dist"),
  ];
}

/**
 * node_repl 是官方能力共用的宿主工具，不是任何插件 manifest 声明的 plugin MCP。产物由独立的
 * `node-repl-host` seed 单元携带（无 listing、不对用户露出）；Browser Use
 * 贡献自己的 skill、docs 与 native 依赖 root。
 */
export function resolveBuiltInNodeReplMcpServers(input: {
  pluginOutcome: Pick<PluginLoadOutcome, "plugins">;
  workingDirectory: string;
}): Record<string, McpServerConfig> {
  const browserUsePackage = input.pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_BROWSER_USE_PLUGIN_ID && plugin.enabled,
  );
  if (!browserUsePackage) return {};
  // 宿主自己不参与启用判断：它没有 skill、不对用户露出，缺失就意味着没有宿主可跑，
  // 必须安全地不注册，而不是回退到某个插件包里的旧产物。
  const hostPackage = input.pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_NODE_REPL_HOST_PLUGIN_ID,
  );
  if (!hostPackage) return {};

  // W-14 桥接（S7 缝）：引擎 sidecar 产物目录注入 node_repl env。
  // 打包态首选 resourcesPath 锚点（G1，2026-10-11 装机审计修复）：插件 seed 后
  // hostPackage.rootPath 是缓存路径（…/cache/freecodez/node-repl-host/<ver>），原先
  // 「rootPath 旁的 computer-engine-dist」按 staging 布局算层级、在缓存布局下永远够不着；
  // agent 由 Electron Helper-as-node 拉起，resourcesPath 指向 app Resources，与
  // prepare-agent-node-bundle 的 glm/packages/computer-engine-dist staging 对齐，且随
  // app 升级即时换血（不读缓存副本）。开发态：workspace 引擎包 dist / 包根上溯。
  // fail-closed：sidecar 不在场不注入（bridge 报显式错，绝不空 env 静默降级）。
  const engineDistDir = computerEngineDistCandidates({
    pluginRootPath: hostPackage.rootPath,
    workingDirectory: input.workingDirectory,
    resourcesPath: process.resourcesPath,
  }).find((dir) => existsSync(join(dir, "computer-sidecar.js")));

  const nodeRepl = createBundledMcpRuntimeConfig({
    cwd: input.workingDirectory,
    env: withComputerEngineEnv(
      {
        // 领域 root 各自注入，且只在对应能力启用时注入：宿主据此决定哪一半文档可用。
        ZCODE_PLUGIN_ROOT: browserUsePackage.rootPath,
      },
      {
        engineDistDir,
        engineReady: engineDistDir !== undefined,
      },
    ),
    rootPath: hostPackage.rootPath,
    timeoutMs: 600_000,
  });
  if (!nodeRepl) return {};
  return {
    [BUILT_IN_NODE_REPL_SERVER_NAME]: {
      ...nodeRepl,
      isolation: "workspace",
      protocolVersion: "2026-07-28",
    },
  };
}
