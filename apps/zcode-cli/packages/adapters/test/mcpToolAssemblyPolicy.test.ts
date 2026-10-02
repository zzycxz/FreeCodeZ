// spec: mcp-availability-first-cost-management §8 —— 装配过滤与连接豁免单测。
// 覆盖：denylist 语义（空名单全放行/命中剔除/未知名忽略）、服务端声明剔除、
// 连接收敛豁免（仅 disabledTools 变化不重连）、目录缓存 TTL/指纹/LRU。
import assert from "node:assert/strict";
import test from "node:test";
import {
  connectionRelevantConfigEqual,
  filterModelAssemblyTools,
} from "../src/mcp/index.js";
import {
  McpToolCatalogCache,
  toolCatalogConnectionFingerprint,
} from "../src/mcp/tool-catalog-cache.js";
import type { McpToolDescriptor, McpServerConfig } from "@zcode/contracts";

function tool(toolName: string, extra: Partial<McpToolDescriptor> = {}): McpToolDescriptor {
  return {
    serverName: "srv",
    toolName,
    inputSchema: { type: "object", properties: {} },
    ...extra,
  };
}

const stdioConfig = (overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
  type: "stdio",
  command: "npx",
  args: ["-y", "some-mcp"],
  ...overrides,
});

test("filterModelAssemblyTools: 缺省全放行（R1），denylist 命中才剔除", () => {
  const tools = [tool("a"), tool("b"), tool("c")];
  assert.equal(filterModelAssemblyTools(tools, undefined).length, 3);
  assert.equal(filterModelAssemblyTools(tools, []).length, 3);
  const filtered = filterModelAssemblyTools(tools, ["b"]);
  assert.deepEqual(
    filtered.map((t) => t.toolName),
    ["a", "c"],
  );
  // 未知名静默忽略（验收 §7.6）。
  assert.equal(filterModelAssemblyTools(tools, ["ghost", "a"]).length, 2);
});

test("filterModelAssemblyTools: 服务端声明不可见（modelVisible=false）剔除，缺省可见", () => {
  const tools = [
    tool("visible"),
    tool("uiOnly", { modelVisible: false }),
    tool("explicit", { modelVisible: true }),
  ];
  assert.deepEqual(
    filterModelAssemblyTools(tools, undefined).map((t) => t.toolName),
    ["visible", "explicit"],
  );
  // 服务端声明与用户名单独立叠加（R4 闭集两类）。
  assert.deepEqual(
    filterModelAssemblyTools(tools, ["visible"]).map((t) => t.toolName),
    ["explicit"],
  );
});

test("connectionRelevantConfigEqual: 仅 disabledTools 变化视为相等（豁免重连，规则 2.1）", () => {
  const a = stdioConfig();
  const b = stdioConfig({ disabledTools: ["x"] });
  assert.equal(connectionRelevantConfigEqual(a, b), true);
  // 连接字段变化则不等：args/env/url/command 任一变化都构成重连理由。
  assert.equal(
    connectionRelevantConfigEqual(a, stdioConfig({ args: ["-y", "other"] })),
    false,
  );
  assert.equal(
    connectionRelevantConfigEqual(a, stdioConfig({ env: { K: "V" } })),
    false,
  );
  assert.equal(connectionRelevantConfigEqual(a, undefined), false);
  assert.equal(connectionRelevantConfigEqual(undefined, undefined), false);
});

test("toolCatalogConnectionFingerprint: disabledTools 不影响指纹", () => {
  const a = toolCatalogConnectionFingerprint(stdioConfig());
  const b = toolCatalogConnectionFingerprint(stdioConfig({ disabledTools: ["x"] }));
  assert.equal(a, b);
  assert.notEqual(a, toolCatalogConnectionFingerprint(stdioConfig({ command: "other" })));
});

test("McpToolCatalogCache: TTL 过期与指纹失配不命中，LRU 容量淘汰最旧", () => {
  let now = 1_000;
  const cache = new McpToolCatalogCache({ capacity: 2, ttlMs: 100, clock: { now: () => now } });
  const fingerprint = toolCatalogConnectionFingerprint(stdioConfig());
  cache.set("a", { tools: [tool("a1")], connectionFingerprint: fingerprint, storedAt: now });
  assert.equal(cache.get("a", fingerprint)?.tools.length, 1);

  // TTL 过期。
  now += 101;
  assert.equal(cache.get("a", fingerprint), undefined);
  // 过期条目被清除后同指纹可重新写入命中。
  cache.set("a", { tools: [tool("a2")], connectionFingerprint: fingerprint, storedAt: now });
  assert.equal(cache.get("a", fingerprint)?.tools[0]?.toolName, "a2");

  // LRU：容量 2，写入 c 淘汰最旧的 b；刚触碰的 a 保留。
  cache.set("b", { tools: [], connectionFingerprint: fingerprint, storedAt: now });
  cache.get("a", fingerprint);
  cache.set("c", { tools: [], connectionFingerprint: fingerprint, storedAt: now });
  assert.equal(cache.get("a", fingerprint) !== undefined, true);
  assert.equal(cache.get("c", fingerprint) !== undefined, true);

  // 指纹失配（连接配置变化）不命中，且失配探测会顺带清除陈旧条目（防占 LRU 位）。
  const otherFingerprint = toolCatalogConnectionFingerprint(stdioConfig({ command: "other" }));
  assert.equal(cache.get("a", otherFingerprint), undefined);
  assert.equal(cache.get("a", fingerprint) !== undefined, false);

  // 显式失效。
  cache.invalidate("c");
  assert.equal(cache.get("c", fingerprint), undefined);
});
