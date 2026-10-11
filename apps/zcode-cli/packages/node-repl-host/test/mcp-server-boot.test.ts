// 回归测试：node_repl MCP bundle（dist/mcp/server.js）必须能完成真实 SDK 握手并注册 js 工具。
//
// 背景（2026-10-11 实障）：esbuild 内联 zod/v4/classic 时把模块体包进 __esm 懒初始化包装、
// 把 lazy 等 function 声明提升到包装外，而 @modelcontextprotocol/core 的 auth chunk 在模块
// 顶层就调用 z.lazy(...) —— ZodLazy 尚未赋值，bundle **模块求值阶段**直接抛
// "ZodLazy is not a constructor"，进程死在 MCP 握手 probe 之前，宿主只留下一句
// "connection closed during the server/discover probe"，注册 0 工具、js 工具整个消失。
// 修复 = src/zod-eager-init.ts 以首位 import 抢先触发 init_schemas2()。
// 本测试用宿主同款 @modelcontextprotocol/client + pin 2026-07-28 真连一次，
// 覆盖"bundle 启动即崩"与"js 工具不注册"两个失效面。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { buildNodeReplHostBundle } from "../scripts/build.mjs";

test("node_repl bundle 握手可用：js 工具注册（ZodLazy 懒初始化时序回归）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "node-repl-host-boot-test-"));
  const outfile = join(dir, "server.js");
  const client = new Client(
    { name: "boot-test", version: "0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await buildNodeReplHostBundle({ outfile });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [outfile],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(
      tools.tools.some((tool) => tool.name === "js"),
      `js tool must be registered, got: ${tools.tools.map((t) => t.name).join(", ") || "(none)"}`,
    );
    await client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
