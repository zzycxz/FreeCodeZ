// spec: mcp-availability-first-cost-management §7 —— 运行时链路集成测试（可自动化的冒烟核心）。
// 用真实 stdio MCP server（fixtures/minimal-mcp-server.mjs）走完整连接链，覆盖验收：
//   1（劣质形态全量注入 + ui_only 声明剔除）、2/5（disabledTools 收敛不重连）、
//   3（list_changed 后新工具默认放行）、缓存 connecting 窗口并入装配。
import assert from "node:assert/strict";
import test from "node:test";
import { createMcpAdapter } from "../src/mcp/index.js";
import type { McpPort, McpServerConfig } from "@zcode/contracts";

const FIXTURE = new URL("./fixtures/minimal-mcp-server.mjs", import.meta.url).pathname;
const SLOW_INIT_MS = 400;

function serverConfig(): McpServerConfig {
  return {
    type: "stdio",
    command: process.execPath,
    args: [FIXTURE],
    env: { SLOW_INIT_MS: String(SLOW_INIT_MS) },
  };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(false, message);
}

test("集成：全量注入、visibility 剔除、disabledTools 收敛豁免、list_changed 放行、缓存并入", async (t) => {
  const adapter = createMcpAdapter({ clientName: "zcode-test", clientVersion: "0.0.0" });
  t.after(async () => {
    await adapter.close();
  });

  // —— 段 A：首连（慢速 server），验收 1：默认全量注入 + ui_only 服务端声明剔除。
  await adapter.connectConfiguredServers({ fixture: serverConfig() });
  let statuses = await adapter.status();
  assert.equal(statuses.fixture?.status, "connected");
  assert.equal(statuses.fixture?.toolCount, 3);
  assert.equal(statuses.fixture?.visibleToolCount, 2);
  let tools = await adapter.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.toolName).sort(),
    ["alpha", "beta"],
  );

  // 观测明细（规则 2.3）：3 条 + 两类归因。
  const summaries = adapter.serverToolSummaries?.("fixture");
  assert.equal(summaries?.length, 3);
  const summaryByName = new Map(summaries?.map((item) => [item.toolName, item]) ?? []);
  assert.equal(summaryByName.get("ui_only")?.modelVisible, false);
  assert.equal(summaryByName.get("ui_only")?.disabled, false);
  assert.equal(summaryByName.get("alpha")?.modelVisible, true);
  assert.ok((summaryByName.get("alpha")?.estimatedTokens ?? 0) > 0);

  // —— 段 A2：验收 2/7：仅 disabledTools 变化的收敛豁免——不重连。
  const updatedAtBefore = statuses.fixture?.updatedAt;
  await adapter.connectConfiguredServers({
    fixture: { ...serverConfig(), disabledTools: ["alpha"] },
  });
  statuses = await adapter.status();
  assert.equal(statuses.fixture?.status, "connected");
  // updatedAt 不变 = 豁免分支复用既有 status（connectServer 必然生成新时间戳）。
  assert.equal(statuses.fixture?.updatedAt, updatedAtBefore);
  // v2（4 工具）到达后：alpha 用户剔除 + ui_only 服务端剔除 → visible 2。
  await waitFor(
    async () => (await adapter.status()).fixture?.toolCount === 4,
    3_000,
    "tools/list_changed 未刷新 toolCount",
  );
  const statusesAfterChange = await adapter.status();
  assert.equal(statusesAfterChange.fixture?.visibleToolCount, 2);
  tools = await adapter.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.toolName).sort(),
    ["beta", "gamma"],
  );

  // —— 段 B：缓存 connecting 窗口（规则 2.5）：断开重连期间 listTools 命中目录缓存。
  await adapter.disconnectServer("fixture");
  const reconnectPromise = adapter.connectConfiguredServers({ fixture: serverConfig() });
  // 等 connecting record 落位（closeRecord → set connectingRecord 有微小空窗）；
  // SLOW_INIT_MS 保证 connecting 状态有足够窗口可观察。
  await waitFor(
    async () => (await adapter.status()).fixture?.status === "connecting",
    2_000,
    "未观察到 connecting 状态",
  );
  const connectingTools = await adapter.listTools();
  assert.ok(
    connectingTools.length > 0,
    "connecting 窗口应并入目录缓存工具，而不是空装配",
  );
  await reconnectPromise;
  // 重连是新 server 进程：首次 tools/list 返回 v1，需等其 list_changed 推送重拉到 v2。
  await waitFor(
    async () => (await adapter.status()).fixture?.toolCount === 4,
    3_000,
    "重连后 list_changed 未刷新到 v2",
  );
  const liveTools = await adapter.listTools();
  assert.equal(liveTools.length, 3);
});

test("集成（C2）：server 意外退出后装配摘除幻影工具，原始 tools 保留", async (t) => {
  const adapter = createMcpAdapter({ clientName: "zcode-test", clientVersion: "0.0.0" });
  t.after(async () => {
    await adapter.close();
  });
  // EXIT_AFTER_MS：连接成功后 server 自行退出，触发 unexpected_disconnect。
  await adapter.connectConfiguredServers({
    fixture: {
      type: "stdio",
      command: process.execPath,
      args: [FIXTURE],
      env: { EXIT_AFTER_MS: "500" },
    },
  });
  await waitFor(
    async () => (await adapter.status()).fixture?.status === "connected",
    3_000,
    "初始连接未成功",
  );
  const before = await adapter.listTools();
  assert.equal(before.length, 2, "连接期 alpha/beta 正常装配");

  await waitFor(
    async () => (await adapter.status()).fixture?.status === "disconnected",
    5_000,
    "server 退出后未进入 disconnected",
  );
  const after = await adapter.listTools();
  assert.equal(after.length, 0, "断连后装配不得再包含该 server 的幻影工具");

  // record.tools 保留原始全量（恢复后无需重新拉取即可回归装配）。EXIT_AFTER_MS=500
  // 晚于 list_changed 推送（150ms），故此处清单已是 v2（4 工具）。
  const summaries = adapter.serverToolSummaries?.("fixture");
  assert.equal(summaries?.length, 4, "断连仅摘装配，原始工具清单保留");
});
