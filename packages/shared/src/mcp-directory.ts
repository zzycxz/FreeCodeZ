// ============================================================
// 条目 8（升级实施手册，spec §12）：MCP 目录态（deferred）装配层
// ============================================================
// 语义（spec §12 修订后）：per-server toolExposure:"deferred" + 全局
// features.mcpDeferredTools 双门开时，该 server 的工具以「名称+一行描述」进
// 目录段（不注入 inputSchema）；模型引用目录中的工具时由装配层展开 schema
// 完成调用。默认（缺省 full 或 flag 关）行为与现状逐字节一致——R1 红线不动。
//
// 本模块 = 目录段渲染（纯件）+ 装配分流函数；调用展开与入口契约硬化在
// core 的 directory-entry.ts（目录入口工具工厂），由 registerMcpToolsWithDirectory
// 的 registerDirectoryTool 回调接线。

/** 最小结构面（与 contracts McpToolDescriptor 同构可传；shared 不依赖 contracts）。 */
export interface McpDirectoryDescriptor {
  toolName: string;
  description?: string;
  /** 与 contracts McpToolAnnotations 同构的子集（只取 destructiveHint 一位）。 */
  annotations?: { destructiveHint?: boolean };
}

/** 目录段单 server 上限（防劣质 server 把目录撑爆——观察值仍在设置页可见）。 */
export const MCP_DIRECTORY_MAX_TOOLS_PER_SERVER = 100;
/** 单工具目录行预算（名称+描述截断）。 */
export const MCP_DIRECTORY_LINE_BUDGET_CHARS = 200;

export interface McpDirectoryToolLine {
  toolName: string;
  description: string;
  /** 服务端声明 destructiveHint：渲染成截不掉的 [destructive] 标注（修复批问题 A）。 */
  destructive?: boolean;
}

/** 组单 server 的目录行（描述保首行+末行并截预算；超过上限丢弃并计数）。 */
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
    // 修复批问题 A（A/B 证据：破坏性/排他约束常写在第 2 行，单取首行会被吃掉后模型
    // 误选近邻工具）：多行描述保「首行 … 末行」，合并串再走同一预算（尾部截断不变）。
    const parts = (descriptor.description ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const firstLine = parts[0] ?? "";
    const lastLine = parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
    const combined = lastLine ? `${firstLine} … ${lastLine}` : firstLine;
    const description =
      combined.length > budget ? `${combined.slice(0, budget - 1)}…` : combined;
    lines.push({
      toolName: descriptor.toolName,
      description,
      ...(descriptor.annotations?.destructiveHint === true ? { destructive: true } : {}),
    });
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
    .map(
      (line) =>
        `- ${line.toolName}${line.destructive ? " [destructive]" : ""}${line.description ? `: ${line.description}` : ""}`,
    )
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
