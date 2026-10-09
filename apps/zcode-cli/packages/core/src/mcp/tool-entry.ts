// ============================================================
// MCP descriptor → ToolEntry 构造（自 mcp/index.ts 拆出）
// ============================================================
// max-lines 400 惯例的纯搬移（koffi-tree 模式），语义零变化。

import {
  type JsonSchema,
  type McpPort,
  type McpToolDescriptor,
  type ModelToolSideEffectScope,
  type RiskLevel,
} from "@zcode/contracts";
import type { ToolEntry } from "../tool/types.js";
import { normalizeMcpToolResultForModel } from "./image-normalization.js";
import { formatMcpToolResult } from "./mcp-result-format.js";
import { toMcpToolName } from "./name.js";

export const MCP_TOOL_TIMEOUT_MS = 30_000;

export function toRegisteredMcpToolName(descriptor: McpToolDescriptor): string {
  return toMcpToolName(descriptor);
}

export function createMcpToolEntry(
  name: string,
  descriptor: McpToolDescriptor,
  mcpPort: McpPort,
): ToolEntry {
  const readOnly = descriptor.annotations?.readOnlyHint === true;
  const destructive = descriptor.annotations?.destructiveHint === true;
  const isHostNodeReplExecution =
    descriptor.serverName === "node_repl" && descriptor.toolName === "js";
  // 宿主 node_repl 的 js 能执行本机 Node 代码，不能沿用普通未知 MCP 的 medium/network
  // 默认值；否则权限 UI 会把文件/进程级能力错误描述成普通网络调用。
  const sideEffectScope: ModelToolSideEffectScope = isHostNodeReplExecution ? "system" : "network";
  const riskLevel: RiskLevel = isHostNodeReplExecution
    ? "high"
    : destructive
      ? "high"
      : readOnly
        ? "low"
        : "medium";
  const needsApproval = true;
  const timeoutMs = descriptor.timeoutMs ?? MCP_TOOL_TIMEOUT_MS;
  const resultBudget = isHostNodeReplExecution
      ? {
          maxInlineBytes: 1_000_000,
          maxModelBytes: 64 * 1024,
          strategy: "artifact" as const,
          preview: { direction: "tail" as const, maxBytes: 64 * 1024 },
          artifact: { enabled: true, retention: "session" as const },
        }
      : {
          maxInlineBytes: 100_000,
          maxModelBytes: 50_000,
          strategy: "truncate" as const,
          preview: { direction: "head" as const },
        };

  return {

    capability: `MCP tool exposed by ${descriptor.serverName}: ${descriptor.toolName}`,
    inputSchema: createModelFacingMcpInputSchema(descriptor),
    outputSchema: McpToolOutputJsonSchema,
    metadata: {
      concurrentSafe: readOnly || descriptor.annotations?.idempotentHint === true,
      destructive,
      // 必须把 MCP tool 的 description 透传到 metadata，让 registry 把它带进模型输入，
      // 否则模型侧只看到 name + inputSchema，调用 MCP 工具时缺乏判断依据。
      description: descriptor.description,
      name,
      mcpPresentation: {
        serverName: descriptor.serverName,
        toolName: descriptor.toolName,
        ...(descriptor.description ? { description: descriptor.description } : {}),
      },
      needsApproval,
      readOnly,
      riskLevel,
      sideEffectScope,
      timeoutMs,
    },
    permission: {
      permission: "mcp",
      reason: `MCP tool ${descriptor.serverName}/${descriptor.toolName} executes through an external server`,
      riskLevel,
      sideEffectScope,
      needsApproval,
      patternSources: ["toolName", "input", "network"],
      denyPriority: "beforeAsk",
    },
    resultBudget,
    timeout: {
      defaultMs: timeoutMs,
      allowCallOverride: false,
    },
    cancellation: {
      supported: true,
      cleanup: "bestEffort",
      userVisibleMessage: `MCP tool ${name} was cancelled`,
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
    handler: async (input, context) => {
      const result = await mcpPort.callTool(
        {
          serverName: descriptor.serverName,
          toolName: descriptor.toolName,
          arguments: toMcpRuntimeArguments(input),
          trace: {
            traceId: context.traceId,
            spanId: context.spanId,
            parentSpanId: context.parentSpanId,
            sessionId: context.sessionId,
            turnId: context.turnId,
          },
          runtimeScope: context.runtimeScope ?? "main",
          workspacePath: context.workingDirectory,
          ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
          ...(context.workspaceIdentity?.trim()
            ? {
                workspaceIdentity: context.workspaceIdentity.trim(),
                workspaceKey: context.workspaceIdentity.trim(),
              }
            : { workspaceKey: context.workingDirectory }),
          ...(context.turnId ? { turnId: context.turnId } : {}),
          clientMode: context.clientMode ?? "desktop-continuous",
          deliveryKind: context.deliveryKind ?? "desktop-continuous",
        },
        {
          signal: context.abortSignal,
          timeoutMs,
        },
      );
      // MCP server 会返回大 base64 图片；resultBudget 只看到图片占位文本，
      // 必须在 handler 阶段保存副本并替换模型可见内容，避免 provider 请求体被打爆。
      return normalizeMcpToolResultForModel({
        compressOversizedImages: isHostNodeReplExecution,
        context,
        descriptor,
        result,
        toolName: name,
      });
    },
    formatModelContent: (output) => formatMcpToolResult(output),
  };
}

export const McpToolOutputJsonSchema = {
  type: "object",
  required: ["content"],
  properties: {
    content: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
      },
    },
    structuredContent: {},
    isError: {
      type: "boolean",
    },
    _meta: {
      type: "object",
      additionalProperties: true,
    },
  },
  additionalProperties: false,
} satisfies JsonSchema;

function normalizeInputSchema(schema: JsonSchema | undefined): JsonSchema {
  if (!schema || typeof schema !== "object") {
    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
  }

  return {
    ...schema,
    type: "object",
    properties:
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? schema.properties
        : {},
  };
}

function createModelFacingMcpInputSchema(descriptor: McpToolDescriptor): JsonSchema {
  return normalizeInputSchema(descriptor.inputSchema);
}

function toRecordInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

function toMcpRuntimeArguments(input: unknown): Record<string, unknown> {
  return toRecordInput(input);
}
