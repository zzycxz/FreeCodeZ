// 修复批 B（spec §12）：目录入口工具契约硬化测试——A/B 证据的 7/9 入口违规
// （空载荷 5 次、错键 target 等 2 次）必须被「归一 + schema 形引导」一次重试内消化。
import assert from "node:assert/strict";
import test from "node:test";
import type { McpToolDescriptor } from "@zcode/contracts";
import { createMcpDirectoryEntry, directoryEntryToolName } from "../src/mcp/directory-entry.js";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandlerFailure,
  ToolInputValidationResult,
} from "../src/tool/types.js";

const descriptors: McpToolDescriptor[] = [
  {
    serverName: "issue-tracker",
    toolName: "get_issue",
    description: "Get one issue.",
    inputSchema: {
      type: "object",
      properties: { issue_id: { type: "string" } },
      required: ["issue_id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    serverName: "issue-tracker",
    toolName: "archive_project",
    description: "Archive a project.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" } },
      required: ["project_id"],
    },
    annotations: { destructiveHint: true },
  },
];

interface Normalizer {
  safeParse: (
    value: unknown,
  ) => { success: boolean; data?: unknown; error?: { issues: Array<{ message: string }> } };
}

function makeEntry(invoke?: (toolName: string, input: unknown) => Promise<unknown>): ToolEntry {
  return createMcpDirectoryEntry({
    serverName: "issue-tracker",
    directoryText: "## MCP tools available via issue-tracker (directory mode)",
    descriptors,
    invoke: invoke ?? (async () => ({ content: [{ type: "text", text: "ok" }] })),
  });
}

test("入口名构造：server 名消毒后拼目录入口", () => {
  assert.equal(directoryEntryToolName("issue-tracker"), "mcp__issue-tracker__directory");
  assert.equal(directoryEntryToolName("a.b/c"), "mcp__a_b_c__directory");
});

test("归一：别名键折入 tool_name、大小写归一、散铺参数收进 input、缺名折空串", () => {
  const normalizer = makeEntry().runtimeInputSchema as Normalizer;

  const folded = normalizer.safeParse({ target: "GET_ISSUE", issue_id: "ISSUE-1" });
  assert.equal(folded.success, true);
  assert.deepEqual(folded.data, { tool_name: "get_issue", input: { issue_id: "ISSUE-1" } });

  const explicit = normalizer.safeParse({ toolName: "archive_project", input: { project_id: "p" } });
  assert.equal(explicit.success, true);
  assert.deepEqual(explicit.data, { tool_name: "archive_project", input: { project_id: "p" } });

  const empty = normalizer.safeParse({});
  assert.equal(empty.success, true);
  assert.deepEqual(empty.data, { tool_name: "" });

  const mixed = normalizer.safeParse({ tool_name: "", target: "get_issue" });
  assert.equal(mixed.success, true);
  assert.deepEqual(mixed.data, { tool_name: "get_issue" }, "空 tool_name 不压过后续非空别名键");

  assert.equal(normalizer.safeParse("nope").success, false);
});

test("空名 → 400 schema 形引导（含工具名清单 + Nothing was started）", () => {
  const entry = makeEntry();
  const result = entry.validateInput?.({ tool_name: "  " }, {}) as ToolInputValidationResult;
  assert.equal(result.result, false);
  const failure = result as ToolHandlerFailure;
  assert.equal(failure.errorCode, 400);
  assert.ok(failure.message.includes("non-empty `tool_name`"));
  assert.ok(failure.message.includes("get_issue"));
  assert.ok(failure.message.includes("archive_project"));
  assert.ok(failure.message.includes("Nothing was started"));
});

test("未知名 → 404 schema 形引导（含可用名清单）", () => {
  const entry = makeEntry();
  const result = entry.validateInput?.({ tool_name: "delete_all" }, {}) as ToolInputValidationResult;
  assert.equal(result.result, false);
  const failure = result as ToolHandlerFailure;
  assert.equal(failure.errorCode, 404);
  assert.ok(failure.message.includes("delete_all"));
  assert.ok(failure.message.includes("Available names"));
  assert.equal(entry.validateInput?.({ tool_name: "get_issue" }, {}).result, true);
});

test("按需展开：缺 input 揭示 schema；参数不合法带 errors 揭示；合法即执行", async () => {
  const calls: Array<{ toolName: string; input: unknown }> = [];
  const entry = makeEntry(async (toolName, input) => {
    calls.push({ toolName, input });
    return { content: [{ type: "text", text: "done" }] };
  });
  const context = {} as ToolExecutionContext;

  const reveal = (await entry.handler({ tool_name: "get_issue" }, context)) as {
    content: Array<{ text: string }>;
  };
  const payload = JSON.parse(reveal.content[0]?.text ?? "{}");
  assert.equal(payload.tool, "get_issue");
  assert.deepEqual(payload.input_schema, descriptors[0]?.inputSchema);
  assert.equal(payload.errors, undefined);
  assert.equal(calls.length, 0);

  const badReveal = (await entry.handler(
    { tool_name: "get_issue", input: {} },
    context,
  )) as { content: Array<{ text: string }> };
  const badPayload = JSON.parse(badReveal.content[0]?.text ?? "{}");
  assert.ok(Array.isArray(badPayload.errors));
  assert.ok(String(badPayload.errors[0]).includes("issue_id"));
  assert.equal(calls.length, 0);

  await entry.handler({ tool_name: "get_issue", input: { issue_id: "ISSUE-1" } }, context);
  assert.deepEqual(calls, [{ toolName: "get_issue", input: { issue_id: "ISSUE-1" } }]);
});

test("风险回投：resolvePermissionCapability 按 tool_name 投目标 annotations 位", () => {
  const entry = makeEntry();
  const readCap = entry.resolvePermissionCapability?.({ tool_name: "get_issue" });
  assert.equal(readCap?.readOnly, true);
  assert.equal(readCap?.destructive, false);
  assert.equal(readCap?.riskLevel, "low");
  const boomCap = entry.resolvePermissionCapability?.({ tool_name: "archive_project" });
  assert.equal(boomCap?.destructive, true);
  assert.equal(boomCap?.riskLevel, "high");
  assert.equal(entry.resolvePermissionCapability?.({ tool_name: "nope" }), undefined);
});

test("入口描述携带目录段全文与 tool_name 契约强调", () => {
  const entry = makeEntry();
  assert.ok(entry.metadata.description?.includes("## MCP tools available via issue-tracker"));
  assert.ok(entry.metadata.description?.includes("set `tool_name`"));
  assert.equal(entry.metadata.needsApproval, true);
  assert.equal(entry.metadata.destructive, true, "目标集含 destructive 工具时入口取保守位");
});
