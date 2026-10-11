import type {
  McpPort,
  McpServerConfig,
  McpServerStatus,
} from "@zcode/contracts";

export async function listMcpServerStatuses(
  mcpPort: McpPort | undefined,
  servers: Record<string, McpServerConfig>,
  untrustedServerNames: ReadonlySet<string> = new Set(),
): Promise<Record<string, McpServerStatus>> {
  const liveStatuses = mcpPort ? await mcpPort.status() : {};
  const updatedAt = new Date().toISOString();
  const statuses: Record<string, McpServerStatus> = {};

  for (const [name, config] of Object.entries(servers)) {
    const configuredStatus = getConfiguredServerStatus(name, config, untrustedServerNames);
    statuses[name] = liveStatuses[name] ?? {
      status: configuredStatus,
      transport: config.type,
      toolCount: 0,
      updatedAt,
      error: getConfiguredServerError(name, config, untrustedServerNames),
      ...(configuredStatus === "untrusted" ? { failureKind: "status_unavailable" as const } : {}),
    };
  }

  for (const [name, status] of Object.entries(liveStatuses)) {
    if (!(name in statuses)) statuses[name] = status;
  }

  return statuses;
}

/**
 * W-14 桥接（S7 缝）：node_repl 的引擎面 env 注入。自有键名（R7：不留 ZCODE_* 回退）。
 * fail-closed：sidecar 产物不在场（引擎未构建/未随 seed 携带）→ 不注入任何键，
 * bridge 侧显式报"engine sidecar is not built"——绝不空凭据静默降级。
 */
export function withComputerEngineEnv(
  env: Record<string, string | undefined>,
  input: { engineDistDir?: string; engineReady?: boolean } = {},
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) base[key] = value;
  }
  if (input.engineReady !== true || !input.engineDistDir) return base;
  return {
    ...base,
    FREECODEZ_CUA_ENGINE_SIDECAR: input.engineDistDir,
    FREECODEZ_CUA_ENGINE_READY: "1",
  };
}

export function omitMcpServers(
  servers: Record<string, McpServerConfig>,
  omittedNames: ReadonlySet<string>,
): Record<string, McpServerConfig> {
  return Object.fromEntries(Object.entries(servers).filter(([name]) => !omittedNames.has(name)));
}

function getConfiguredServerStatus(
  name: string,
  config: McpServerConfig,
  untrustedServerNames: ReadonlySet<string>,
): McpServerStatus["status"] {
  if (config.enabled === false) return "disabled";
  return untrustedServerNames.has(name) ? "untrusted" : "disconnected";
}

function getConfiguredServerError(
  name: string,
  config: McpServerConfig,
  untrustedServerNames: ReadonlySet<string>,
): string | undefined {
  if (config.enabled === false || !untrustedServerNames.has(name)) return undefined;
  return "Project MCP server requires explicit connection before use.";
}
