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
