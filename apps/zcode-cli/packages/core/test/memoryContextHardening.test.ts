// 0C-2 修复测试（升级实施手册）：
// ① MEMORY.md 索引注入收窄 25K→10K + memory 指令段 cacheHint dynamic→stable（常量文本
//    排进前缀稳定区，不再白断缓存）。
// ② microcompact 清工具结果后，memory 抽取的 provider 输入按 toolCallId 从持久化消息
//    找回原文（占位符不再侵蚀抽取）。
// ③ Write/Edit 内容强标识：full read 内容不同必 stale——堵 revisionId(mtime,size) 弱标识
//    在同秒同长度改写下的盲区；跨进程 CAS（stale_write）既有语义不回归。
import assert from "node:assert/strict";
import test from "node:test";
import { formatProjectMemoryIndexContent } from "../src/memory/index-content.js";
import { buildMemorySection } from "../src/context/sections/memory.js";
import { MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE } from "../src/compact/microcompact.js";
import { restoreClearedToolResults } from "../src/runtime/helpers/project-memory-extraction.js";
import { getEditableReadStateFailure } from "../src/tool/handlers/edit.js";

test("0C-2①：索引注入超 10K 截断（25K→10K 收窄）", () => {
  const big = Array.from({ length: 2000 }, (_, index) => `- entry ${index} ${"x".repeat(20)}`).join("\n");
  assert.ok(big.length > 25_000, "样本须超旧上限");
  const formatted = formatProjectMemoryIndexContent(big);
  assert.ok(formatted.length <= 10_500, `截断后须 ≤10K 量级（实际 ${formatted.length}）`);
  assert.ok(formatted.includes("WARNING: MEMORY.md"), "截断提示保留");
  // 10K 以内零截断。
  const small = Array.from({ length: 100 }, (_, index) => `- entry ${index}`).join("\n");
  assert.equal(formatProjectMemoryIndexContent(small), small);
});

test("0C-2①：memory 指令段 cacheHint=stable（常量文本不再打断前缀缓存）", () => {
  const section = buildMemorySection("/mem/root");
  assert.ok(section, "memoryRoot 在场时必有 section");
  assert.equal(section.cacheHint, "stable");
});

test("0C-2②：占位符工具结果按 toolCallId 从持久化消息恢复原文", () => {
  const entries = [
    { message: { role: "user" as const, content: "please check the file" } },
    { message: { role: "assistant" as const, content: "reading now", toolCalls: [{ id: "call-1" }] } },
    { message: { role: "tool" as const, toolCallId: "call-1", toolName: "Read", content: MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE } },
    { message: { role: "tool" as const, toolCallId: "call-2", toolName: "Grep", content: "kept intact output" } },
  ];
  const durable = [
    {
      info: { id: "m1", role: "assistant" as const, synthetic: false, visibility: "transcript" as const },
      parts: [
        { type: "tool" as const, toolCallId: "call-1", state: { status: "completed", output: "line1\nline2\nthe original read output" } },
      ],
    },
  ];
  const restored = restoreClearedToolResults(entries as never, durable as never);
  assert.equal(
    (restored[2] as { message: { content: string } }).message.content,
    "line1\nline2\nthe original read output",
    "被清的 call-1 必须恢复原文",
  );
  assert.equal(
    (restored[3] as { message: { content: string } }).message.content,
    "kept intact output",
    "未被清的条目逐字保留",
  );
  assert.equal((restored[0] as { message: { content: string } }).message.content, "please check the file");
});

test("0C-2②：无占位符时零改动（快路径）", () => {
  const entries = [
    { message: { role: "user" as const, content: "hello" } },
    { message: { role: "tool" as const, toolCallId: "call-9", toolName: "Bash", content: "real output" } },
  ];
  const restored = restoreClearedToolResults(entries as never, [] as never);
  assert.equal((restored[1] as { message: { content: string } }).message.content, "real output");
});

test("0C-2③：内容强标识——同 mtime/size 但内容不同必 stale（Edit）", () => {
  const weakRevision = { id: "mtime:100:size:10", mtimeMs: 100, sizeBytes: 10 };
  const readFileState = new Map([
    ["k1", {
      path: "/repo/a.txt",
      content: "AAAAAAAAAA",
      mtimeMs: 100,
      sizeBytes: 10,
      revisionId: "mtime:100:size:10",
      offset: 1,
      isPartialView: false,
      readAt: new Date(),
    }],
  ]);
  // 磁盘内容已被另一会话改写，但 mtime（截断后）与 size 恰好相同——revisionId 弱标识盲区。
  const currentRead = { content: "BBBBBBBBBB", revision: weakRevision, sizeBytes: 10 } as never;
  const failure = getEditableReadStateFailure("/repo/a.txt", currentRead, readFileState);
  assert.ok(failure, "内容不同必须判 stale（0C-2③ 强标识）");

  // 内容一致 + mtime/size 相同 → 不 stale（既有语义零回归）。
  const sameRead = { content: "AAAAAAAAAA", revision: weakRevision, sizeBytes: 10 } as never;
  assert.equal(getEditableReadStateFailure("/repo/a.txt", sameRead, readFileState), undefined);
});

test("0C-2②：持久化消息找不到时保持占位符（防御，不崩不丢）", () => {
  const entries = [
    { message: { role: "tool" as const, toolCallId: "call-x", toolName: "Read", content: MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE } },
  ];
  const restored = restoreClearedToolResults(entries as never, [] as never);
  assert.equal(
    (restored[0] as { message: { content: string } }).message.content,
    MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE,
  );
});
