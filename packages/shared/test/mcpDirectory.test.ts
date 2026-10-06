// 条目 8（spec §12）：MCP 目录态装配层纯件测试。
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMcpDirectoryLines,
  formatMcpDirectorySection,
  splitMcpToolsByExposure,
  MCP_DIRECTORY_MAX_TOOLS_PER_SERVER,
  MCP_DIRECTORY_LINE_BUDGET_CHARS,
} from "../src/mcp-directory.js";

const descriptors = Array.from({ length: 120 }, (_, index) => ({
  toolName: `tool_${index}`,
  description: index % 2 === 0 ? `Does thing ${index}` : `Multi\nline description ${index}\nwith third line`,
}));

test("目录行：描述保首行+末行并截预算；超上限丢弃并计数", () => {
  const { lines, truncated } = buildMcpDirectoryLines(descriptors);
  assert.equal(lines.length, MCP_DIRECTORY_MAX_TOOLS_PER_SERVER);
  assert.equal(truncated, 20);
  for (const line of lines) {
    assert.ok(!line.description.includes("\n"), "描述合并后不含换行");
    assert.ok(line.description.length <= MCP_DIRECTORY_LINE_BUDGET_CHARS);
  }
  // 多行描述保「首行 … 末行」（修复批 A：排他/破坏性约束常在末行，不能被截掉）
  assert.equal(lines[1]?.description, "Multi … with third line");
});

test("修复批 A：末行排他约束保留；单行不变；空段收敛", () => {
  const { lines } = buildMcpDirectoryLines([
    {
      toolName: "archive_project",
      description:
        "Archive a project, making it read-only.\nDestructive and hard to reverse; only when the user explicitly wants to retire a project.",
    },
    { toolName: "single", description: "first line only" },
    { toolName: "spaced", description: "  a  \n b \n\n  c  \n" },
    { toolName: "blank", description: "\n\n" },
  ]);
  assert.equal(
    lines[0]?.description,
    "Archive a project, making it read-only. … Destructive and hard to reverse; only when the user explicitly wants to retire a project.",
  );
  assert.equal(lines[1]?.description, "first line only");
  assert.equal(lines[2]?.description, "a … c");
  assert.equal(lines[3]?.description, "");
});

test("修复批 A：合并串超预算走尾部截断；[destructive] 标注进目录行", () => {
  const { lines } = buildMcpDirectoryLines([
    { toolName: "long", description: `${"h".repeat(120)}\n${"t".repeat(120)}` },
    { toolName: "boom", description: "Deletes stuff", annotations: { destructiveHint: true } },
    { toolName: "fine", description: "Reads stuff", annotations: { destructiveHint: false } },
    { toolName: "plain", description: "No annotations key" },
  ]);
  assert.ok((lines[0]?.description.length ?? 0) <= MCP_DIRECTORY_LINE_BUDGET_CHARS);
  assert.ok(lines[0]?.description.endsWith("…"));
  assert.equal(lines[0]?.description.includes("…"), true);
  assert.equal(lines[1]?.destructive, true);
  assert.equal(lines[2]?.destructive, undefined);
  assert.equal(lines[3]?.destructive, undefined);
  const text = formatMcpDirectorySection({ serverName: "s", lines, truncated: 0 });
  assert.ok(text?.includes("- boom [destructive]: Deletes stuff"));
  assert.ok(text?.includes("- fine: Reads stuff"));
  assert.ok(text?.includes("- plain: No annotations key"));
  assert.ok(text?.includes(`- long: ${"h".repeat(120)} … `));
});

test("空描述与超长截断", () => {
  const { lines } = buildMcpDirectoryLines([{ toolName: "a" }, { toolName: "b", description: "x".repeat(500) }]);
  assert.equal(lines[0]?.description, "");
  assert.ok(lines[1]?.description.endsWith("…"));
  assert.ok((lines[1]?.description.length ?? 0) <= MCP_DIRECTORY_LINE_BUDGET_CHARS);
});

test("目录段文本：空 server 无产出；含引导语与 omitted 尾注", () => {
  assert.equal(formatMcpDirectorySection({ serverName: "s", lines: [], truncated: 0 }), undefined);
  const text = formatMcpDirectorySection({
    serverName: "my-server",
    lines: [
      { toolName: "search", description: "Search things" },
      { toolName: "get", description: "" },
    ],
    truncated: 3,
  });
  assert.ok(text?.includes("## MCP tools available via my-server (directory mode)"));
  assert.ok(text?.includes("- search: Search things"));
  assert.ok(text?.includes("- get"));
  assert.ok(text?.includes("(3 more tools omitted)"));
});

test("装配分流双门：flag 关或档 full → 全部 full（现状逐字节）；双开 → 全部 deferred", () => {
  const input = { serverName: "s", descriptors: descriptors.slice(0, 3) };
  assert.equal(splitMcpToolsByExposure({ ...input, toolExposure: "deferred", globalDeferredEnabled: false }).full.length, 3);
  assert.equal(splitMcpToolsByExposure({ ...input, toolExposure: "deferred", globalDeferredEnabled: false }).deferred.length, 0);
  assert.equal(splitMcpToolsByExposure({ ...input, toolExposure: "full", globalDeferredEnabled: true }).full.length, 3);
  assert.equal(splitMcpToolsByExposure({ ...input, toolExposure: undefined, globalDeferredEnabled: true }).full.length, 3);
  const both = splitMcpToolsByExposure({ ...input, toolExposure: "deferred", globalDeferredEnabled: true });
  assert.equal(both.full.length, 0);
  assert.equal(both.deferred.length, 3);
});
