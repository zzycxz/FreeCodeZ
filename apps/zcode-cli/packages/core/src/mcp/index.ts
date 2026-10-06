// MCP tool bridge - projects MCP descriptors into core tool entries
// （ToolEntry 构造在 tool-entry.ts、结果投影在 mcp-result-format.ts——max-lines 拆分，语义零变化）

import type { McpPort, McpToolDescriptor } from "@zcode/contracts";
import type { ToolRegistry } from "../tool/registry.js";
import { createToolRuleNameSet } from "../tool/tool-visibility.js";
import {
  buildMcpDirectoryLines,
  formatMcpDirectorySection,
  splitMcpToolsByExposure,
} from "@zcode/shared";
import { directoryEntryToolName, toMcpToolName } from "./name.js";
import {
  createMcpToolEntry,
  toRegisteredMcpToolName,
} from "./tool-entry.js";

export { toMcpToolName } from "./name.js";

export {
  HOST_NODE_REPL_IMAGE_MAX_DIMENSION,
  MCP_IMAGE_INLINE_BASE64_BYTES,
  MCP_IMAGE_INLINE_RAW_BYTES,
} from "./image-normalization.js";

export { McpToolOutputJsonSchema, MCP_TOOL_TIMEOUT_MS } from "./tool-entry.js";

export interface RegisterMcpToolsOptions {
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  /**
   * 由 runtime 使用不可伪造的 product authority 凭据验明的官方 CUA server。
   * 名称本身不构成信任；省略时 fail-closed，所有 MCP 都按普通工具处理，
   * 不投影官方 CUA 规范名，也不挂载 provider 拼写别名。
   */
  officialCuaServerNames?: ReadonlySet<string>;
}

/**
 * allow/deny 名单判定（registerMcpTools 与目录态 deferred 分流共用同一谓词）：
 * 官方 CUA 投影模型主名后，只按新名检查会让升级前保存的 namespaced denylist 静默
 * 失效。新旧名称任一命中 deny 即拒绝，任一命中 allow 即接受。
 */
function mcpToolNamePermitted(
  name: string,
  descriptorName: string,
  allowed: ReadonlySet<string> | undefined,
  disallowed: ReadonlySet<string> | undefined,
): boolean {
  if (allowed && !allowed.has(name) && !allowed.has(descriptorName)) return false;
  if (disallowed?.has(name) || disallowed?.has(descriptorName)) return false;
  return true;
}

export function registerMcpTools(
  registry: ToolRegistry,
  mcpPort: McpPort,
  descriptors: readonly McpToolDescriptor[],
  options: RegisterMcpToolsOptions = {},
): string[] {
  const allowed = options.allowedTools ? new Set(options.allowedTools) : undefined;
  const disallowed = createToolRuleNameSet(options.disallowedTools);
  const registered: string[] = [];

  for (const descriptor of descriptors) {
    const officialCuaAuthorityVerified =
      options.officialCuaServerNames?.has(descriptor.serverName) === true;
    const descriptorName = toMcpToolName(descriptor);
    const name = toRegisteredMcpToolName(descriptor, officialCuaAuthorityVerified);
    if (!mcpToolNamePermitted(name, descriptorName, allowed, disallowed)) continue;
    registry.register(createMcpToolEntry(name, descriptor, mcpPort, officialCuaAuthorityVerified));
    registered.push(name);
  }

  return registered;
}

/**
 * 条目 8（spec §12）目录态：deferred server 的工具不逐个注册（schema 不注入），
 * 改注册一个「目录+按需展开」入口工具；展开与契约硬化（别名归一/空名与未知名
 * schema 形引导/按需展开）由 createMcpDirectoryEntry（directory-entry.ts）承担。
 * 返回注册的工具名列表（full 部分照常走 registerMcpTools）。
 */
export function registerMcpToolsWithDirectory(
  registry: ToolRegistry,
  mcpPort: McpPort,
  descriptors: readonly McpToolDescriptor[],
  options: RegisterMcpToolsOptions & {
    serverExposure?: Record<string, "full" | "deferred" | undefined>;
    globalDeferredEnabled?: boolean;
    registerDirectoryTool?: (
      serverName: string,
      directoryText: string,
      descriptors: readonly McpToolDescriptor[],
      invoke: (toolName: string, input: unknown) => Promise<unknown>,
    ) => void;
  },
): { registered: string[]; directoryServers: string[] } {
  const { serverExposure, globalDeferredEnabled, registerDirectoryTool, ...rest } = options;
  if (!globalDeferredEnabled || !registerDirectoryTool) {
    // 全局门关：与现状逐字节一致。
    return { registered: registerMcpTools(registry, mcpPort, descriptors, rest), directoryServers: [] };
  }
  const byServer = new Map<string, McpToolDescriptor[]>();
  for (const descriptor of descriptors) {
    const list = byServer.get(descriptor.serverName) ?? [];
    list.push(descriptor);
    byServer.set(descriptor.serverName, list);
  }
  const allowed = rest.allowedTools ? new Set(rest.allowedTools) : undefined;
  const disallowed = createToolRuleNameSet(rest.disallowedTools);
  const registered: string[] = [];
  const directoryServers: string[] = [];
  for (const [serverName, serverDescriptors] of byServer) {
    const { full, deferred } = splitMcpToolsByExposure<McpToolDescriptor>({
      serverName,
      toolExposure: serverExposure?.[serverName],
      globalDeferredEnabled,
      descriptors: serverDescriptors,
    });
    if (full.length > 0) {
      // 排查补漏（修复批同轮）：这里曾置 allowedTools: undefined——flag 一开，
      // scoped 子代理/workflow 子运行时的 toolAllowlist 会静默失效。与全局门关的
      // 回退路径保持逐字节一致：allow/deny 照常过滤。
      registered.push(...registerMcpTools(registry, mcpPort, full, rest));
    }
    if (deferred.length > 0) {
      // 目录与入口走同一 allow/deny 谓词（工具逐一过名单）；入口名本身不进 allowlist
      // 语义（它是入选工具的通道），但单独命中 deny 即整条通道关闭。
      const permittedDeferred = deferred.filter((descriptor) =>
        mcpToolNamePermitted(
          toRegisteredMcpToolName(
            descriptor,
            rest.officialCuaServerNames?.has(descriptor.serverName) === true,
          ),
          toMcpToolName(descriptor),
          allowed,
          disallowed,
        ),
      );
      if (permittedDeferred.length > 0 && !disallowed?.has(directoryEntryToolName(serverName))) {
        const { lines, truncated } = buildMcpDirectoryLines(permittedDeferred);
        const text = formatMcpDirectorySection({ serverName, lines, truncated });
        if (text) {
          registerDirectoryTool(serverName, text, permittedDeferred, (toolName, input) =>
            mcpPort.callTool({
              serverName,
              toolName,
              arguments: (input ?? {}) as Record<string, unknown>,
            }),
          );
          directoryServers.push(serverName);
        }
      }
    }
  }
  return { registered, directoryServers };
}

