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
  // 打包态：hostPackage.rootPath 旁的 computer-engine-dist/；开发态：workspace 引擎包 dist。
  // fail-closed：sidecar 不在场不注入（bridge 报显式错，绝不空 env 静默降级）。
  const engineDistCandidates = [
    resolve(hostPackage.rootPath, "..", "computer-engine-dist"),
    resolve(input.workingDirectory, "..", "computer-engine", "dist"),
    resolve(hostPackage.rootPath, "../../../../packages/computer-engine/dist"),
  ];
  const engineDistDir = engineDistCandidates.find((dir) =>
    existsSync(join(dir, "computer-sidecar.js")),
  );

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
