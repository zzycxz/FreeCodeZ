import type { McpToolDescriptor } from "@zcode/contracts";

export function toMcpToolName(
  descriptor: Pick<McpToolDescriptor, "name" | "serverName" | "toolName">,
): string {
  return (
    descriptor.name ??
    `mcp__${toModelVisibleMcpNamePart(descriptor.serverName)}__${toModelVisibleMcpNamePart(
      descriptor.toolName,
    )}`
  );
}

export function toModelVisibleMcpNamePart(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

/** 目录入口工具的模型可见名（deferred server 的统一入口，见 spec §12 修复批）。 */
export function directoryEntryToolName(serverName: string): string {
  return `mcp__${toModelVisibleMcpNamePart(serverName)}__directory`;
}

export function matchesModelVisibleMcpServerName(
  requiredName: string,
  serverName: string,
): boolean {
  const expected = requiredName.trim().toLowerCase();
  if (expected.length === 0) return false;

  const rawServerName = serverName.trim().toLowerCase();
  const modelVisibleServerName = toModelVisibleMcpNamePart(serverName).toLowerCase();

  return (
    rawServerName === expected ||
    modelVisibleServerName === expected ||
    rawServerName.includes(expected) ||
    modelVisibleServerName.includes(expected)
  );
}
