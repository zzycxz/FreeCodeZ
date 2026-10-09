import { join } from "node:path";
import type { AgentRuntimeConfig } from "@zcode/core";
import type { PluginLoadOutcome } from "@zcode/contracts";
import { OFFICIAL_BROWSER_USE_PLUGIN_ID } from "./official-plugin-definitions.js";

type RuntimeFeaturesConfig = NonNullable<AgentRuntimeConfig["runtimeFeatures"]>;

export function resolvePluginRuntimeFeatures(
  pluginOutcome: Pick<PluginLoadOutcome, "plugins">,
): RuntimeFeaturesConfig {
  const browserUsePlugin = pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_BROWSER_USE_PLUGIN_ID && plugin.enabled,
  );
  if (!browserUsePlugin) {
    return {};
  }
  return {
    // Node REPL 已迁到真实 MCP server；这里仅启用 BrowserControlPort 注入，不再注册 core 裸 js*。
    browserUse: true,
    browserDocumentationRoot: join(browserUsePlugin.rootPath, "docs"),
  };
}
