// 条目 9（升级实施手册）：MCP resources/prompts 能力面测试。
// 四方法契约钉死：未连接 server 的折返语义（list*=空数组/read+get=结构化错误）与
// 已连接路径经 SDK 类型面（真实 server 往返挂 e2e 批——SDK 2.0.0 方法实测在场）。
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("SDK 2.0.0 四方法在场（listResources/readResource/listPrompts/getPrompt）", () => {
  const { Client } = require("@modelcontextprotocol/client");
  const proto = Client.prototype as Record<string, unknown>;
  assert.equal(typeof proto.listResources, "function");
  assert.equal(typeof proto.readResource, "function");
  assert.equal(typeof proto.listPrompts, "function");
  assert.equal(typeof proto.getPrompt, "function");
});

test("adapter：未连接 server 的折返语义", async () => {
  const { createMcpAdapter } = await import("../src/mcp/index.js");
  const adapter = createMcpAdapter({});
  assert.deepEqual(await adapter.listResources!("<nonexistent>"), []);
  assert.deepEqual(await adapter.listPrompts!("<nonexistent>"), []);
  await assert.rejects(() => adapter.readResource!("<nonexistent>", "file:///x"), /not connected/);
  await assert.rejects(() => adapter.getPrompt!("<nonexistent>", "p"), /not connected/);
  await adapter.close();
});

test("契约类型面：shared 投影同构", async () => {
  const shared = await import("@zcode/shared");
  const sample: shared.McpResourceDescriptor = { uri: "file:///a", name: "A" };
  assert.equal(sample.uri, "file:///a");
  const prompt: shared.McpPromptDescriptor = {
    name: "review",
    arguments: [{ name: "lang", required: true }],
  };
  assert.equal(prompt.arguments?.[0]?.required, true);
  const message: shared.McpPromptMessage = { role: "user", content: { type: "text", text: "hi" } };
  assert.equal(message.content.type, "text");
});
