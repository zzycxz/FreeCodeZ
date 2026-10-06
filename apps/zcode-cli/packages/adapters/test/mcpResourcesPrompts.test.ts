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

test("e2e：真实 stdio server 全链走通（resources list/read + prompts list/get）", async () => {
  const FIXTURE = new URL("./fixtures/resources-prompts-server.mjs", import.meta.url).pathname;
  const { createMcpAdapter } = await import("../src/mcp/index.js");
  const adapter = createMcpAdapter({});
  try {
    await adapter.connectConfiguredServers({
      "rp-fixture": {
        type: "stdio" as const,
        command: process.execPath,
        args: [FIXTURE],
      },
    });
    // 等连接就绪
    for (let i = 0; i < 20; i++) {
      const status = await adapter.status();
      if (status["rp-fixture"]?.status === "connected") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const resources = await adapter.listResources!("rp-fixture");
    assert.equal(resources.length, 2);
    assert.equal(resources[0]?.uri, "config://app");
    assert.equal(resources[0]?.name, "App Config");

    const contents = await adapter.readResource!("rp-fixture", "config://app");
    assert.equal(contents.length, 1);
    assert.equal(contents[0]?.text, "content of config://app");

    const prompts = await adapter.listPrompts!("rp-fixture");
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0]?.name, "review");
    assert.equal(prompts[0]?.arguments?.[0]?.required, true);

    const messages = await adapter.getPrompt!("rp-fixture", "review", { lang: "zh" });
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.content.text, "prompt review in zh");
    assert.equal(messages[0]?.role, "user");
  } finally {
    await adapter.close();
  }
}, 15_000);
