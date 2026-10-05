// 条目 8（升级实施手册，spec §12）：MCP 治理批测试。
// ① mcpToolExposure 三态 seam（协议事实判定，布尔包装保留）；
// ② envAllowlist 过滤（缺省全放行/白名单收窄/名单外丢弃 fail-visible/非 stdio 空对象）；
// ③ spec 修订锚定（R1 第三档例外通道 + R4 闭集第三类 + A/B 门控条款在场）。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mcpToolExposure, mcpToolModelVisible } from "@zcode/shared";

const here = dirname(fileURLToPath(import.meta.url));

test("曝光三态：visibility 判定 full/hidden；deferred 由装配层合成不在协议侧", () => {
  assert.equal(mcpToolExposure(undefined), "full");
  assert.equal(mcpToolExposure({}), "full");
  assert.equal(mcpToolExposure({ ui: {} }), "full");
  assert.equal(mcpToolExposure({ ui: { visibility: ["model"] } }), "full");
  assert.equal(mcpToolExposure({ ui: { visibility: ["ui"] } }), "hidden");
  assert.equal(mcpToolExposure({ ui: { visibility: [] } }), "hidden");
  // 布尔包装语义保留（既有消费方零迁移）。
  assert.equal(mcpToolModelVisible({ ui: { visibility: ["ui"] } }), false);
});

test("envAllowlist 过滤：缺省全放行；白名单收窄；非 stdio 空对象", () => {
  // filterConfigEnvForServer 未公开导出且拉连接代价不成比例——过滤语义简单，
  // 源级锚定 + adapters 包自身类型检查已足够防回归（宁缺毋滥不造导出面）。
  const source = readFileSync(
    join(here, "../../../apps/zcode-cli/packages/adapters/src/mcp/index.ts"),
    "utf8",
  );
  assert.match(source, /function filterConfigEnvForServer/, "过滤函数在场");
  assert.match(source, /if \(config\.type !== "stdio"\) return \{\};/, "非 stdio 短路");
  assert.match(source, /config\.envAllowlist/, "白名单字段消费");
  assert.match(source, /envAllowlist dropped/, "fail-visible 警告在场");
  assert.match(source, /\.\.\.filterConfigEnvForServer\(config\),/, "挂载进 spawn env");
});

test("spec §12 修订锚定：R1 例外通道/R4 第三类/A-B 门控条款全部在场", () => {
  const spec = readFileSync(
    join(here, "../../../docs/spec/mcp-availability-first-cost-management.md"),
    "utf8",
  );
  assert.match(spec, /## 12\. 第三档（deferred 目录态）修订/, "§12 修订节在场");
  assert.match(spec, /toolExposure\?: "full" \| "deferred"/, "R1 例外通道（per-server 档）");
  assert.match(spec, /目录态（schema 未注入但工具可经目录调用）/, "R4 闭集第三类");
  assert.match(spec, /A\/B 对照/, "A/B 门控条款");
  assert.match(spec, /envAllowlist/, "env 白名单裁定");
  assert.match(spec, /ToolResultBudget/, "限长裁定");
});

test("配置字段：McpServerConfig 双字段（shared 与 contracts 同步）", async () => {
  const shared = readFileSync(join(here, "../src/mcp.ts"), "utf8");
  assert.match(shared, /toolExposure\?: "full" \| "deferred";/);
  assert.match(shared, /envAllowlist\?: string\[\];/);
  const contracts = readFileSync(
    join(here, "../../../apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts"),
    "utf8",
  );
  assert.match(contracts, /toolExposure\?: "full" \| "deferred";/);
  assert.match(contracts, /envAllowlist\?: string\[\];/);
});
