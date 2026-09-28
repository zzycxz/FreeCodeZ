// FreeCodeZ fork(Bots):replyMode 四档颗粒度解析与块渲染、3500 切片、变更摘要生成（附录B §2.5/§5.2）。
// 运行: node --test packages/services/test/botsReply.test.ts（经 tsx 加载源码）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  listReplyModeOptions,
  resolveReplyGranularityByValue,
  normalizeBotReplyGranularity,
} from "@zcode/shared/bots";
import {
  blocksToMessages,
  createAssistantReplyBlocks,
  formatBotChangeSummary,
  splitLongReplyText,
  type BotChangeSummary,
  type BotReplyPart,
  type BotReplyToolCall,
} from "../src/bots/replyPipeline.js";
import { buildPerTurnChangeSummaries } from "../src/bots/taskBridge.js";

test("replyMode 颗粒度解析：序号 / 别名 / label / mode；非法值 null", () => {
  // 非飞书渠道三档：标准/完整/摘要
  assert.equal(resolveReplyGranularityByValue("telegram", "1"), "assistant_changes");
  assert.equal(resolveReplyGranularityByValue("telegram", "2"), "assistant_toolcalls_changes");
  assert.equal(resolveReplyGranularityByValue("telegram", "3"), "summary_changes");
  assert.equal(resolveReplyGranularityByValue("telegram", "full"), "assistant_toolcalls_changes");
  assert.equal(resolveReplyGranularityByValue("telegram", "toolcalls"), "assistant_toolcalls_changes");
  assert.equal(resolveReplyGranularityByValue("telegram", "摘要"), "summary_changes");
  assert.equal(resolveReplyGranularityByValue("telegram", "standard"), "assistant_changes");
  assert.equal(resolveReplyGranularityByValue("telegram", "4"), null);
  assert.equal(resolveReplyGranularityByValue("telegram", "nope"), null);
  // 飞书/Lark 仅流式卡片一档
  assert.equal(resolveReplyGranularityByValue("feishu", "1"), "streaming_card");
  assert.equal(resolveReplyGranularityByValue("lark", "stream"), "streaming_card");
  assert.equal(resolveReplyGranularityByValue("feishu", "summary"), null);
  // 选项目录过滤
  assert.equal(listReplyModeOptions("feishu").length, 1);
  assert.equal(listReplyModeOptions("telegram").length, 3);
  // 规范化：不支持的档回落支持集[0]
  assert.equal(normalizeBotReplyGranularity("feishu", "assistant_changes"), "streaming_card");
  assert.equal(normalizeBotReplyGranularity("telegram", "streaming_card"), "assistant_changes");
  assert.equal(normalizeBotReplyGranularity("telegram", undefined), "assistant_changes");
});

test("3500 切片：优先在换行/空格断开", () => {
  const text = `${"a".repeat(3400)}\n${"b".repeat(200)}`;
  const slices = splitLongReplyText(text);
  assert.ok(slices.length >= 2);
  for (const slice of slices) assert.ok(slice.length <= 3500);
  assert.equal(slices.join(""), text.replace(/\n/gu, ""));
  assert.deepEqual(splitLongReplyText("short"), ["short"]);
});

test("变更摘要生成：buildPerTurnChangeSummaries 行差聚合 + 按 path 排序", () => {
  const summaries = buildPerTurnChangeSummaries([
    {
      turnIndex: 0,
      snapshots: [
        { path: "b.ts", beforeContent: "1\n2\n3", afterContent: "1\n2\n3\n4", writeCount: 1 },
        { path: "a.ts", beforeContent: "x\ny", afterContent: "x", writeCount: 2 },
        // 同 path 合并：afterContent 取最后一次、writeCount 累加
        { path: "a.ts", beforeContent: "x", afterContent: "x\nz", writeCount: 1 },
      ],
    },
  ]);
  const summary = summaries.get(0);
  assert.ok(summary);
  assert.equal(summary.fileCount, 2);
  assert.deepEqual(
    summary.files.map((file) => file.path),
    ["a.ts", "b.ts"],
  );
  const a = summary.files[0];
  const b = summary.files[1];
  assert.ok(a && b);
  // a.ts: before "x\ny" → after "x\nz"（合并后）：+1(z) -1(y)
  assert.equal(a.added, 1);
  assert.equal(a.removed, 1);
  assert.equal(a.writeCount, 3);
  // b.ts: +1
  assert.equal(b.added, 1);
  assert.equal(b.removed, 0);
});

test("变更摘要文本：≤10 文件，超出 moreFiles{count}", () => {
  const files = Array.from({ length: 12 }, (_unused, index) => ({
    path: `f${String(index).padStart(2, "0")}.ts`,
    added: 1,
    removed: index === 0 ? 2 : 0,
    writeCount: 1,
    lastTurnIndex: 0,
  }));
  const summary: BotChangeSummary = {
    fileCount: 12,
    added: 12,
    removed: 2,
    files,
  };
  const zh = formatBotChangeSummary(summary, { locale: "zh-CN" });
  const lines = zh.split("\n");
  assert.equal(lines[0], "变更摘要：12 个文件，🟢 `+12` 🔴 `-2`");
  assert.equal(lines.length, 12); // header + 10 files + moreFiles 行
  assert.equal(lines.at(-1), "- 还有 2 个文件");
  assert.ok(zh.includes("- `f00.ts` (🟢 `+1` 🔴 `-2`)"));
  const en = formatBotChangeSummary(summary, { locale: "en-US" });
  assert.ok(en.startsWith("Change summary: 12 files,"));
  assert.ok(en.includes("- 2 more files"));
  // 空摘要 → 空串
  assert.equal(formatBotChangeSummary(null), "");
});

test("replyMode 四档块渲染：summary=最新块；assistant=全部 content；toolcalls=+工具块", () => {
  const parts: BotReplyPart[] = [
    { type: "content", content: "first " },
    { type: "thought", content: "hidden" },
    { type: "tool-call", toolId: "t1" },
    { type: "content", content: "second" },
    { type: "content", content: " third" },
  ];
  const toolCalls = new Map<string, BotReplyToolCall>([
    ["t1", { toolId: "t1", title: "read file", kind: "read", status: "completed" }],
  ]);
  const summary: BotChangeSummary = {
    fileCount: 1,
    added: 3,
    removed: 0,
    files: [{ path: "a.ts", added: 3, removed: 0, writeCount: 1, lastTurnIndex: 0 }],
  };

  const summaryBlocks = createAssistantReplyBlocks(parts, toolCalls, "summary_changes", summary);
  assert.equal(summaryBlocks[0]?.type, "content");
  assert.equal(summaryBlocks.at(-1)?.type, "change-summary");
  const summaryText = blocksToMessages(summaryBlocks, { locale: "zh-CN" });
  // summary 档只发最新 content 块（second third）+ 变更摘要
  assert.ok(summaryText[0]?.includes("second third"));

  const standardBlocks = createAssistantReplyBlocks(parts, toolCalls, "assistant_changes", summary);
  assert.deepEqual(
    standardBlocks.map((block) => block.type),
    ["content", "content", "change-summary"],
  );

  const fullBlocks = createAssistantReplyBlocks(
    parts,
    toolCalls,
    "assistant_toolcalls_changes",
    summary,
  );
  assert.deepEqual(
    fullBlocks.map((block) => block.type),
    ["content", "tool-call", "content", "change-summary"],
  );
  const fullText = blocksToMessages(fullBlocks, { locale: "zh-CN" });
  assert.ok(fullText.some((line) => line.startsWith("工具调用：\n- 完成 · read file")));

  // 无变更摘要不追加
  const noSummary = createAssistantReplyBlocks(parts, toolCalls, "assistant_changes", null);
  assert.ok(!noSummary.some((block) => block.type === "change-summary"));
});
