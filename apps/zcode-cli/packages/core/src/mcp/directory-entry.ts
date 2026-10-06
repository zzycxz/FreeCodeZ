// ============================================================
// 目录入口工具（deferred 按需展开的模型入口）——spec §12 修复批问题 B
// ============================================================
// A/B 证据（scripts/dev/mcp-deferred-ab-results*.json）：deferred 侧 9 次失误里 7 次是
// 入口契约违规——空载荷 {} 5 次、工具名放错键（target 等）2 次。契约硬化成三道：
//   1. runtimeInputSchema 预处理（executor 的 prepareInitialToolExecutionInput seam）：
//      别名键折成 tool_name、缺名折成空串、大小写归一到目录名、散铺参数收进 input。
//      为什么只能活在这：初始 inputSchema 硬门在 validateInput/resolveInput **之前**
//      （call-runner.ts 顺序 prepare→validateInitial→validateInput→resolveInput），
//      别名容忍放后面永远轮不到执行。
//   2. validateInput 对空名/未知名返回 schema 形业务失败 + 可用工具名清单（400/404，
//      hook/权限/确认窗之前收口——与 428 skill 门控同一条生命周期出口）。
//   3. handler 按需展开：input 对目标 inputSchema 校验通过即执行（首调即执行，不强制
//      往返）；缺失/不合法时返回目标工具 schema + 校验错误（「首调用提供 schema」的
//      落地形态；无状态、幂等、可重放）。
// 本工厂无会话态；注册态唯一归 initializeMcp 装配循环（methods/mcp.ts）。

import type {
  JsonSchema,
  McpToolDescriptor,
  ModelToolSideEffectScope,
  RiskLevel,
} from "@zcode/contracts";
import { validateJsonSchemaValue } from "../tool/json-schema.js";
import type {
  ToolHandlerFailure,
  ToolInputValidationResult,
  ToolRuntimePermissionCapability,
  ToolEntry,
} from "../tool/types.js";
import { McpToolOutputJsonSchema, MCP_TOOL_TIMEOUT_MS } from "./tool-entry.js";
import { directoryEntryToolName } from "./name.js";

export { directoryEntryToolName } from "./name.js";

/** 模型把工具名放错键的实测变体（A/B 证据 target/toolName 两次）；一并容忍 name/tool。 */
const TOOL_NAME_ALIAS_KEYS = ["tool_name", "toolName", "name", "tool", "target"] as const;

const MALFORMED_NAME_CODE = 400;
const UNKNOWN_NAME_CODE = 404;
/** 引导错误里的工具名清单上限（防 100 工具 server 把错误撑爆）。 */
const CATALOG_NAME_CAP = 30;

export interface McpDirectoryEntryDeps {
  serverName: string;
  /** formatMcpDirectorySection 产出（目录段全文），原样作入口描述主体。 */
  directoryText: string;
  /** 该 server 的 deferred 工具集（名称与 schema 的唯一来源）。 */
  descriptors: readonly McpToolDescriptor[];
  invoke: (toolName: string, input: unknown) => Promise<unknown>;
}

interface NormalizedDirectoryCall {
  tool_name: string;
  input?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createEntryInputNormalizer(byLowerName: Map<string, McpToolDescriptor>) {
  return {
    safeParse(value: unknown):
      | { success: true; data: NormalizedDirectoryCall }
      | { success: false; error: { issues: Array<{ message: string }> } } {
      if (!isPlainObject(value)) {
        return {
          success: false,
          error: { issues: [{ message: "directory entry input must be an object" }] },
        };
      }
      let rawName: unknown;
      for (const key of TOOL_NAME_ALIAS_KEYS) {
        const candidate = value[key];
        // 取第一个非空值：tool_name:"" 不应压过后面的 target:"x"（A/B 错键实测形态）。
        if (rawName === undefined && candidate !== undefined && String(candidate).trim() !== "") {
          rawName = candidate;
        }
      }
      const trimmed = typeof rawName === "string" ? rawName.trim() : "";
      // 大小写归一到目录里的确切名：下游（hook/权限/handler）看到的就是将要执行的工具名。
      const canonical = byLowerName.get(trimmed.toLowerCase())?.toolName ?? trimmed;

      // 模型偶尔把目标工具参数散铺在顶层（不包 input 一层）；input 缺席时收拢进来，
      // 少一次注定失败的往返。
      const leftover: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        if ((TOOL_NAME_ALIAS_KEYS as readonly string[]).includes(key) || key === "input") continue;
        leftover[key] = entry;
      }
      const hasInput = value.input !== undefined;
      const input = hasInput ? value.input : Object.keys(leftover).length > 0 ? leftover : undefined;
      return {
        success: true,
        data: { tool_name: canonical, ...(input === undefined ? {} : { input }) },
      };
    },
  };
}

function catalogNames(descriptors: readonly McpToolDescriptor[]): string {
  const names = descriptors.map((descriptor) => descriptor.toolName);
  const shown = names.slice(0, CATALOG_NAME_CAP);
  const rest = names.length - shown.length;
  return shown.join(", ") + (rest > 0 ? ` (+${rest} more)` : "");
}

function contractHint(deps: McpDirectoryEntryDeps): string {
  return (
    `Call contract: set \`tool_name\` (required, an exact name from: ${catalogNames(deps.descriptors)}) ` +
    `and optionally \`input\` (that tool's arguments as a JSON object). ` +
    `Always fill the \`tool_name\` field. When \`input\` is missing or invalid, ` +
    `the selected tool's input schema is returned so you can complete the arguments.`
  );
}

function revealResult(
  descriptor: McpToolDescriptor,
  errors: readonly string[],
): { content: Array<{ type: string; text: string }> } {
  const payload = {
    tool: descriptor.toolName,
    ...(descriptor.description ? { description: descriptor.description } : {}),
    input_schema: descriptor.inputSchema,
    ...(errors.length > 0 ? { errors: [...errors] } : {}),
    hint: "Provide arguments in `input` and call this entry again.",
  };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function riskFromAnnotations(
  descriptor: McpToolDescriptor | undefined,
): { readOnly: boolean; destructive: boolean; riskLevel: RiskLevel } {
  const readOnly = descriptor?.annotations?.readOnlyHint === true;
  const destructive = descriptor?.annotations?.destructiveHint === true;
  return {
    readOnly,
    destructive,
    riskLevel: destructive ? "high" : readOnly ? "low" : "medium",
  };
}

export function createMcpDirectoryEntry(deps: McpDirectoryEntryDeps): ToolEntry {
  const byName = new Map(deps.descriptors.map((descriptor) => [descriptor.toolName, descriptor]));
  const byLowerName = new Map(
    deps.descriptors.map((descriptor) => [descriptor.toolName.toLowerCase(), descriptor]),
  );
  const targetRisks = deps.descriptors.map((descriptor) => riskFromAnnotations(descriptor));
  const entryReadOnly = targetRisks.length > 0 && targetRisks.every((risk) => risk.readOnly);
  const entryDestructive = targetRisks.some((risk) => risk.destructive);
  const entryRisk: { readOnly: boolean; destructive: boolean; riskLevel: RiskLevel } = {
    readOnly: entryReadOnly,
    destructive: entryDestructive,
    riskLevel: entryDestructive ? "high" : entryReadOnly ? "low" : "medium",
  };
  const sideEffectScope: ModelToolSideEffectScope = "network";
  const name = directoryEntryToolName(deps.serverName);

  return {
    capability: `MCP directory entry for ${deps.serverName}: call deferred tools by name`,
    inputSchema: {
      type: "object",
      properties: {
        tool_name: {
          type: "string",
          description: "Exact tool name from the directory list (required, non-empty).",
        },
        input: {
          type: "object",
          additionalProperties: true,
          description: "Arguments for the selected tool (see the schema returned on first call).",
        },
      },
      required: ["tool_name"],
      additionalProperties: false,
    } satisfies JsonSchema,
    runtimeInputSchema: createEntryInputNormalizer(byLowerName),
    outputSchema: McpToolOutputJsonSchema,
    metadata: {
      name,
      description: `${deps.directoryText}\n\n${contractHint(deps)}`,
      readOnly: entryRisk.readOnly,
      destructive: entryRisk.destructive,
      concurrentSafe: entryRisk.readOnly,
      needsApproval: true,
      sideEffectScope,
      riskLevel: entryRisk.riskLevel,
      timeoutMs: MCP_TOOL_TIMEOUT_MS,
    },
    permission: {
      permission: "mcp",
      reason: `MCP directory entry ${deps.serverName} executes deferred tools through an external server`,
      riskLevel: entryRisk.riskLevel,
      sideEffectScope,
      needsApproval: true,
      patternSources: ["toolName", "input", "network"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: 100_000,
      maxModelBytes: 50_000,
      strategy: "truncate" as const,
      preview: { direction: "head" as const },
    },
    timeout: { defaultMs: MCP_TOOL_TIMEOUT_MS, allowCallOverride: false },
    cancellation: {
      supported: true,
      cleanup: "bestEffort" as const,
      userVisibleMessage: `MCP directory entry ${name} was cancelled`,
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary" as const,
      recordOutput: "summary" as const,
    },
    validateInput: (input): ToolInputValidationResult => {
      const rawName = isPlainObject(input) && typeof input.tool_name === "string" ? input.tool_name.trim() : "";
      if (rawName.length === 0) {
        const failure: ToolHandlerFailure = {
          result: false,
          errorCode: MALFORMED_NAME_CODE,
          message: `Directory entry requires a non-empty \`tool_name\` field holding one exact name from: ${catalogNames(deps.descriptors)}. ${contractHint(deps)} Nothing was started.`,
        };
        return failure;
      }
      if (!byName.has(rawName)) {
        const failure: ToolHandlerFailure = {
          result: false,
          errorCode: UNKNOWN_NAME_CODE,
          message: `Unknown tool \`${rawName}\`. Available names: ${catalogNames(deps.descriptors)}. ${contractHint(deps)} Nothing was started.`,
        };
        return failure;
      }
      return { result: true };
    },
    resolvePermissionCapability: (input): ToolRuntimePermissionCapability | undefined => {
      const rawName = isPlainObject(input) && typeof input.tool_name === "string" ? input.tool_name : "";
      const target = byName.get(rawName);
      if (!target) return undefined;
      // per-tool 风险回投：入口按调用时的 tool_name 把目标工具的 annotations 位投回
      // 权限层（spec §12 修复批：静态 metadata 只能取并集，精细投影在这一层完成）。
      const risk = riskFromAnnotations(target);
      return {
        readOnly: risk.readOnly,
        destructive: risk.destructive,
        riskLevel: risk.riskLevel,
        needsApproval: true,
        sideEffectScope,
      };
    },
    handler: async (input) => {
      const record = isPlainObject(input) ? input : {};
      const target = byName.get(String(record.tool_name ?? ""));
      if (!target) {
        // validateInput 已挡未知名；仅防御性收口。
        return {
          content: [{ type: "text", text: `Unknown tool \`${String(record.tool_name ?? "")}\`.` }],
          isError: true,
        };
      }
      const args = record.input;
      if (args === undefined || args === null) {
        return revealResult(target, []);
      }
      const check = validateJsonSchemaValue(args, target.inputSchema);
      if (check.valid) {
        return await deps.invoke(target.toolName, args);
      }
      return revealResult(target, check.errors);
    },
  };
}
