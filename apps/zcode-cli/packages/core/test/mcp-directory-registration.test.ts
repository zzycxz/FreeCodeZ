// 修复批同轮排查补漏：registerMcpToolsWithDirectory 的 allow/deny 名单不能因
// 目录态分流而失效——full 臂与回退路径逐字节一致，deferred 臂走同一谓词。
import assert from "node:assert/strict";
import test from "node:test";
import type { McpPort, McpToolDescriptor } from "@zcode/contracts";
import { registerMcpToolsWithDirectory } from "../src/mcp/index.js";
import type { ToolEntry, ToolRegistry } from "../src/tool/types.js";

function makeDescriptors(): McpToolDescriptor[] {
  return [
    {
      serverName: "srv",
      toolName: "alpha",
      description: "Alpha tool.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      serverName: "srv",
      toolName: "beta",
      description: "Beta tool.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      serverName: "srv",
      toolName: "directory",
      description: "与入口同名的普通工具（防重名回归）。",
      inputSchema: { type: "object", properties: {} },
    },
  ];
}

function makeHarness() {
  const registered: ToolEntry[] = [];
  const registry = {
    register: (entry: ToolEntry) => registered.push(entry),
    unregister: () => undefined,
  } as unknown as ToolRegistry;
  const calls: Array<Record<string, unknown>> = [];
  const mcpPort = {
    callTool: async (request: Record<string, unknown>) => {
      calls.push(request);
      return { content: [{ type: "text", text: "ok" }] };
    },
  } as unknown as McpPort;
  const directoryRegistrations: Array<{
    serverName: string;
    text: string;
    descriptors: readonly McpToolDescriptor[];
    invoke: (toolName: string, input: unknown) => Promise<unknown>;
  }> = [];
  return {
    registered,
    registry,
    mcpPort,
    calls,
    directoryRegistrations,
    options: {
      registerDirectoryTool: (
        serverName: string,
        text: string,
        descriptors: readonly McpToolDescriptor[],
        invoke: (toolName: string, input: unknown) => Promise<unknown>,
      ) => {
        directoryRegistrations.push({ serverName, text, descriptors, invoke });
      },
    },
  };
}

test("flag 关：回退路径照常按 allowlist 过滤（现状逐字节）", () => {
  const harness = makeHarness();
  registerMcpToolsWithDirectory(harness.registry, harness.mcpPort, makeDescriptors(), {
    ...harness.options,
    allowedTools: ["mcp__srv__alpha"],
    globalDeferredEnabled: false,
    serverExposure: { srv: "deferred" },
  });
  assert.equal(harness.registered.length, 1);
  assert.equal(harness.registered[0]?.metadata.name, "mcp__srv__alpha");
  assert.equal(harness.directoryRegistrations.length, 0);
});

test("flag 开 + full 臂：allowlist 不得失效（排查补漏回归）", () => {
  const harness = makeHarness();
  registerMcpToolsWithDirectory(harness.registry, harness.mcpPort, makeDescriptors(), {
    ...harness.options,
    allowedTools: ["mcp__srv__alpha"],
    globalDeferredEnabled: true,
    serverExposure: { srv: "full" },
  });
  assert.equal(harness.registered.length, 1);
  assert.equal(harness.registered[0]?.metadata.name, "mcp__srv__alpha");
  assert.equal(harness.directoryRegistrations.length, 0);
});

test("flag 开 + deferred 臂：工具逐一过 allow/deny 名单后才进目录与入口", () => {
  const harness = makeHarness();
  registerMcpToolsWithDirectory(harness.registry, harness.mcpPort, makeDescriptors(), {
    ...harness.options,
    allowedTools: ["mcp__srv__alpha"],
    globalDeferredEnabled: true,
    serverExposure: { srv: "deferred" },
  });
  assert.equal(harness.registered.length, 0);
  assert.equal(harness.directoryRegistrations.length, 1);
  const registration = harness.directoryRegistrations[0];
  assert.deepEqual(
    registration?.descriptors.map((descriptor) => descriptor.toolName),
    ["alpha"],
  );
  assert.ok(registration?.text.includes("- alpha"));

  const denyHarness = makeHarness();
  registerMcpToolsWithDirectory(denyHarness.registry, denyHarness.mcpPort, makeDescriptors(), {
    ...denyHarness.options,
    disallowedTools: ["mcp__srv__beta"],
    globalDeferredEnabled: true,
    serverExposure: { srv: "deferred" },
  });
  const denied = denyHarness.directoryRegistrations[0];
  assert.deepEqual(
    denied?.descriptors.map((descriptor) => descriptor.toolName).sort(),
    ["alpha", "directory"],
  );
  assert.ok(!denied?.text.includes("- beta:"));
});

test("入口名命中 deny：整条目录态通道关闭", () => {
  const harness = makeHarness();
  registerMcpToolsWithDirectory(harness.registry, harness.mcpPort, makeDescriptors(), {
    ...harness.options,
    disallowedTools: ["mcp__srv__directory"],
    globalDeferredEnabled: true,
    serverExposure: { srv: "deferred" },
  });
  assert.equal(harness.directoryRegistrations.length, 0);
  assert.equal(harness.registered.length, 0);
});

test("invoke 回调转发 mcpPort.callTool（server/tool/arguments 原样）", async () => {
  const harness = makeHarness();
  registerMcpToolsWithDirectory(harness.registry, harness.mcpPort, makeDescriptors(), {
    ...harness.options,
    globalDeferredEnabled: true,
    serverExposure: { srv: "deferred" },
  });
  const registration = harness.directoryRegistrations[0];
  assert.ok(registration);
  await registration.invoke("alpha", { x: 1 });
  assert.deepEqual(harness.calls, [
    { serverName: "srv", toolName: "alpha", arguments: { x: 1 } },
  ]);
});
