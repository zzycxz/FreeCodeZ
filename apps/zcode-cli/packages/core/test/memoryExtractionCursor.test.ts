// 0B-4 修复测试（升级实施手册）：memory 抽取 cursor 原先是纯内存（extraction.ts 一处
// `let cursor`）——重启/冷恢复后 cursor 丢失，countMessagesAfterCursor 退化为全量，
// 全史重抽（每次重启都把整段会话再喂一遍抽取 subagent）。
// 修复：scheduler 接 loadCursor/onCursorAdvance 钩子，构造点（project-memory-extraction）
// 落 session entry（runtime/memory_extraction_cursor，稳定 id 覆写式更新）。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createMemoryExtractionScheduler,
  type MemoryExtractionSnapshot,
} from "../src/memory/extraction.js";

const here = dirname(fileURLToPath(import.meta.url));

function message(id: string, text: string): never {
  return {
    info: { id, role: "user", synthetic: false, visibility: "transcript" },
    parts: [{ type: "text", text, ignored: false, synthetic: false }],
  } as never;
}

function snapshot(ids: readonly string[], boundary: string): MemoryExtractionSnapshot {
  const messages = ids.map((id, index) => message(id, `user message number ${index} with words`));
  return {
    boundaryMessageId: boundary as never,
    durableMessages: messages,
    memoryRoot: "/mem",
    workingDirectory: "/repo",
    workspaceRoot: "/repo",
  };
}

async function drain(scheduler: { drain(): Promise<void> }): Promise<void> {
  await scheduler.drain();
}

test("cursor 恢复：loadCursor 返回的持久值生效，重启只抽新增段", async () => {
  const persisted: string[] = [];
  const persistedCursor = "msg-2";
  let executedMessageCounts: number[] = [];
  const scheduler = createMemoryExtractionScheduler(
    async (input) => {
      executedMessageCounts.push(input.messageCount);
      return "success";
    },
    {
      loadCursor: async () => persistedCursor as never,
      onCursorAdvance: (cursor) => persisted.push(cursor),
    },
  );
  // 全史 5 条，cursor 恢复到 msg-2 → 只抽 msg-3..5 = 2 条（msg-2 之后 2 条？5 条消息
  // id: msg-0..msg-4，cursor=msg-2 → 之后是 msg-3/msg-4 = 2 条）。
  scheduler.schedule(snapshot(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"], "msg-4"));
  await drain(scheduler);
  assert.deepEqual(executedMessageCounts, [2], "恢复 cursor 后只统计新增段");
  assert.deepEqual(persisted, ["msg-4"], "成功抽取推进 cursor 并落盘回调");
});

test("skip 路径同样推进 cursor（无 prose 段不再反复重扫）", async () => {
  const persisted: string[] = [];
  const scheduler = createMemoryExtractionScheduler(
    async () => "success",
    { onCursorAdvance: (cursor) => persisted.push(cursor) },
  );
  // 全是 assistant 文本（无合格 user prose）→ skip；cursor 仍推进。
  const snap = {
    ...snapshot(["m1"], "m1"),
    durableMessages: [
      {
        info: { id: "m1", role: "assistant", synthetic: false, visibility: "transcript" },
        parts: [{ type: "text", text: "assistant words here", ignored: false, synthetic: false }],
      },
    ] as never,
  };
  scheduler.schedule(snap);
  await drain(scheduler);
  assert.deepEqual(persisted, ["m1"], "skip 也必须推进 cursor");
});

test("loadCursor 失败按全量处理（宁重抽不漏抽）", async () => {
  const counts: number[] = [];
  const scheduler = createMemoryExtractionScheduler(
    async (input) => {
      counts.push(input.messageCount);
      return "no-op";
    },
    { loadCursor: () => Promise.reject(new Error("store down")) },
  );
  scheduler.schedule(snapshot(["a", "b", "c"], "c"));
  await drain(scheduler);
  assert.deepEqual(counts, [3], "恢复失败退化为全量");
});

test("无钩子 = 旧语义（纯内存，测试装配零改动）", async () => {
  const scheduler = createMemoryExtractionScheduler(async () => "success");
  assert.equal(scheduler.getCursor(), undefined);
  scheduler.schedule(snapshot(["x1", "x2"], "x2"));
  await drain(scheduler);
  assert.equal(scheduler.getCursor(), "x2");
});

test("锚定：构造点接线 loadCursor/onCursorAdvance 落 session entry", () => {
  const source = readFileSync(
    join(here, "../src/runtime/helpers/project-memory-extraction.ts"),
    "utf8",
  );
  assert.match(source, /loadCursor:\s*\(\)\s*=>\s*loadPersistedMemoryExtractionCursor\(runtime\)/);
  assert.match(source, /onCursorAdvance:\s*\(cursor\)\s*=>\s*\{/);
  assert.match(source, /MEMORY_EXTRACTION_CURSOR_ENTRY_TYPE/);
  assert.match(
    source,
    /if \(!runtime\.sessionPersisted\) return;/,
    "落盘必须有 0B-1 同款会话行守卫（FK 窗口）",
  );
});
