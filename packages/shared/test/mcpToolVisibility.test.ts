// spec: mcp-availability-first-cost-management §8 —— 纯函数单测。
// 可见性判定矩阵（R1/R4：缺省放行、仅显式声明隐藏）、估算口径、schema 字节数、
// 协议 snapshot 新字段（visibleToolCount/tools）的 strict 兼容。
import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateMcpServerToolsTokens,
  estimateMcpToolTokens,
  mcpToolModelVisible,
  mcpToolSchemaBytes,
  MCP_TOOL_SCHEMA_LARGE_BYTES,
} from "../src/mcp.js";
import { zcodeMcpServerStatusSnapshotSchema } from "../src/zcode-protocol/index.js";

test("mcpToolModelVisible: 无声明或形态异常一律放行（R1）", () => {
  assert.equal(mcpToolModelVisible(undefined), true);
  assert.equal(mcpToolModelVisible(null), true);
  assert.equal(mcpToolModelVisible("oops"), true);
  assert.equal(mcpToolModelVisible({}), true);
  assert.equal(mcpToolModelVisible({ ui: "oops" }), true);
  assert.equal(mcpToolModelVisible({ ui: { visibility: "oops" } }), true);
  // 空数组是显式声明"无任何可见目标"（MCP Apps 规范），按 codex 同义判定为不可见；
  // 归入下一组用例，此处不作为"形态异常"处理。
});

test("mcpToolModelVisible: visibility 数组按是否含 model 判定", () => {
  assert.equal(mcpToolModelVisible({ ui: { visibility: ["model"] } }), true);
  assert.equal(mcpToolModelVisible({ ui: { visibility: ["model", "ui"] } }), true);
  assert.equal(mcpToolModelVisible({ ui: { visibility: ["ui"] } }), false);
  // 空数组 = 显式声明无任何可见目标，不可见（MCP Apps 规范，codex 同义）。
  assert.equal(mcpToolModelVisible({ ui: { visibility: [] } }), false);
  // 数组存在但元素形态异常：不含 "model" 即不可见（与 codex 判定一致）。
  assert.equal(mcpToolModelVisible({ ui: { visibility: [1, 2] } }), false);
});

test("estimateMcpToolTokens: 中文按 3 计（B1 统一口径）、schema 以序列化长度参与、÷4 向上取整", () => {
  // 纯 ASCII：name(4) + \n + description(11) + \n + schema → 全按 1 计。
  const ascii = estimateMcpToolTokens({
    name: "tool",
    description: "description",
    inputSchema: { type: "object", properties: {} },
  });
  assert.ok(ascii > 0);
  // 中文描述：每个中文按 3 个估算字符计（token-estimate 统一口径），应显著高于同长度 ASCII。
  const zh = estimateMcpToolTokens({ name: "tool", description: "中中中中中" });
  const en = estimateMcpToolTokens({ name: "tool", description: "aaaaa" });
  assert.ok(zh > en);
  // schema 缺席按 0 计；大 schema 单调放大估算。
  const withoutSchema = estimateMcpToolTokens({ name: "t", description: "d" });
  const withBigSchema = estimateMcpToolTokens({
    name: "t",
    description: "d",
    inputSchema: { type: "object", properties: { a: { type: "string", description: "x".repeat(400) } } },
  });
  assert.ok(withBigSchema > withoutSchema);
  // 循环引用等不可序列化 schema 不抛错（safeJsonText 回退空串）。
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.doesNotThrow(() =>
    estimateMcpToolTokens({ name: "t", description: "d", inputSchema: circular }),
  );
});

test("estimateMcpServerToolsTokens / mcpToolSchemaBytes: 求和与字节数口径", () => {
  const total = estimateMcpServerToolsTokens([
    { name: "a", description: "x" },
    { name: "b", description: "y" },
  ]);
  assert.equal(
    total,
    estimateMcpToolTokens({ name: "a", description: "x" }) +
      estimateMcpToolTokens({ name: "b", description: "y" }),
  );
  assert.equal(mcpToolSchemaBytes(undefined), 0);
  assert.equal(mcpToolSchemaBytes({ a: 1 }), JSON.stringify({ a: 1 }).length);
  assert.ok(MCP_TOOL_SCHEMA_LARGE_BYTES > 0);
});

test("snapshot schema: visibleToolCount 与 tools 通过 strict 校验，旧形态（无新字段）兼容", () => {
  const base = {
    status: "connected" as const,
    transport: "stdio" as const,
    toolCount: 3,
    updatedAt: "2026-09-28T00:00:00.000Z",
  };
  // 旧 CLI 无新字段：必须继续通过（向后兼容）。
  assert.equal(zcodeMcpServerStatusSnapshotSchema.safeParse(base).success, true);
  // 新字段齐备。
  const withNewFields = zcodeMcpServerStatusSnapshotSchema.safeParse({
    ...base,
    visibleToolCount: 2,
    tools: [
      {
        toolName: "search",
        description: "search things",
        schemaBytes: 128,
        modelVisible: true,
        disabled: false,
        estimatedTokens: 64,
      },
      {
        toolName: "ui_only",
        schemaBytes: 32,
        modelVisible: false,
        disabled: false,
        estimatedTokens: 16,
      },
    ],
  });
  assert.equal(withNewFields.success, true);
  // strict：未知键仍被拒绝。
  assert.equal(
    zcodeMcpServerStatusSnapshotSchema.safeParse({ ...base, oops: 1 }).success,
    false,
  );
});
