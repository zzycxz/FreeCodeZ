// ============================================================
// 条目 8（升级实施手册，spec §12）：MCP 目录态（deferred）装配层
// ============================================================
// 语义（spec §12 修订后）：per-server toolExposure:"deferred" + 全局
// features.mcpDeferredTools 双门开时，该 server 的工具以「名称+一行描述」进
// 目录段（不注入 inputSchema）；模型引用目录中的工具时由装配层展开 schema
// 完成调用。默认（缺省 full 或 flag 关）行为与现状逐字节一致——R1 红线不动。
//
// 本模块 = 目录态的三个纯件（目录段文本/工具选择/调用展开路由）+ 装配分流函数。
// 调用展开的实现载体（deferred 工具的按需 schema 注入）挂在 ToolEntry 的
// resolveInput 阶段（与 428 skill 门控同 seam）——由 registerMcpTools 的
// options.mcpDeferredEnabled 消费。

/** 最小结构面（与 contracts McpDirectoryDescriptor 同构；shared 不依赖 contracts）。 */
export interface McpDirectoryDescriptor {
  toolName: string;
  description?: string;
}

/** 目录段单 server 上限（防劣质 server 把目录撑爆——观察值仍在设置页可见）。 */
export const MCP_DIRECTORY_MAX_TOOLS_PER_SERVER = 100;
/** 单工具目录行预算（名称+描述截断）。 */
export const MCP_DIRECTORY_LINE_BUDGET_CHARS = 200;

export interface McpDirectoryToolLine {
  toolName: string;
  description: string;
}

/** 组单 server 的目录行（描述截单行；超过上限丢弃并计数）。 */
export function buildMcpDirectoryLines(
  descriptors: readonly McpDirectoryDescriptor[],
  options: { max?: number; lineBudget?: number } = {},
): { lines: McpDirectoryToolLine[]; truncated: number } {
  const max = options.max ?? MCP_DIRECTORY_MAX_TOOLS_PER_SERVER;
  const budget = options.lineBudget ?? MCP_DIRECTORY_LINE_BUDGET_CHARS;
  const lines: McpDirectoryToolLine[] = [];
  let truncated = 0;
  for (const descriptor of descriptors) {
    if (lines.length >= max) {
      truncated += 1;
      continue;
    }
    const rawDescription = descriptor.description ?? "";
    const firstLine = rawDescription.split("\n")[0]?.trim() ?? "";
    const description =
      firstLine.length > budget ? `${firstLine.slice(0, budget - 1)}…` : firstLine;
    lines.push({ toolName: descriptor.toolName, description });
  }
  return { lines, truncated };
}

/** 目录段文本（system prompt 注入体；空 server 不产出）。 */
export function formatMcpDirectorySection(input: {
  serverName: string;
  lines: readonly McpDirectoryToolLine[];
  truncated: number;
}): string | undefined {
  if (input.lines.length === 0) return undefined;
  const rows = input.lines
    .map((line) => `- ${line.toolName}${line.description ? `: ${line.description}` : ""}`)
    .join("\n");
  const trailer = input.truncated > 0 ? `\n(${input.truncated} more tools omitted)` : "";
  return [
    `## MCP tools available via ${input.serverName} (directory mode)`,
    "",
    "These tools are not listed with schemas above. To use one, mention it by name; its schema will be provided on first call.",
    "",
    rows + trailer,
  ].join("\n");
}

/**
 * 装配分流：按 per-server 档 + 全局门把 descriptor 集分成
 * full（照常注册）/deferred（进目录段，不进常规注册）。
 * 双门：全局关或档缺省 → 全部 full（现状）。
 */
export function splitMcpToolsByExposure<T extends McpDirectoryDescriptor>(input: {
  serverName: string;
  toolExposure: "full" | "deferred" | undefined;
  globalDeferredEnabled: boolean;
  descriptors: readonly T[];
}): { full: readonly T[]; deferred: readonly T[] } {
  const useDeferred = input.toolExposure === "deferred" && input.globalDeferredEnabled;
  if (!useDeferred) {
    return { full: input.descriptors, deferred: [] };
  }
  return { full: [], deferred: input.descriptors };
}
