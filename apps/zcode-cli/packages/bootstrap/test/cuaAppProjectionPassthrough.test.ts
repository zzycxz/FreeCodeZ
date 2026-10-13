/**
 * P4b 投影透传（orca 合并后补线）：node-repl 桥经 freecodez/nodeReplCuaApp 上报的
 * CUA 目标应用身份 → ToolCallResult 事件 → ToolCallRow.cuaApp。
 * UI conversationCuaGroups 以 row.cuaApp 为分组键，把 mcp__node_repl__js 行聚成
 * 电脑操作卡组——本链不通时新架构 CUA 行永远只是普通代码块（W-30 死区根因）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import type { SessionEvent } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";

let eventSeq = 0;
function baseEvent(type: SessionEventType, payload: unknown): SessionEvent {
  eventSeq += 1;
  return {
    id: `evt-${eventSeq}`,
    sessionId: "sess-test",
    turnId: "turn-1",
    type,
    timestamp: new Date(),
    traceId: "trace-test",
    sequenceNumber: eventSeq,
    payload,
  } as unknown as SessionEvent;
}

/** 最小开轮序列：TurnStarted（executionKind 缺省=agent）把 phase 推到 running。 */
function startTurn(projection: ProductProjection): void {
  projection.applyEvent(
    baseEvent(SessionEventType.TurnStarted, {
      turnNumber: 1,
      input: "打开备忘录写点什么",
      messageId: "msg-user-1",
    }),
  );
}

function scheduleToolCall(projection: ProductProjection, toolCallId: string, toolName: string): void {
  projection.applyEvent(
    baseEvent(SessionEventType.ToolCallScheduled, {
      toolCallId,
      toolName,
      input: { code: "..." },
    }),
  );
  projection.applyEvent(
    baseEvent(SessionEventType.ToolCallStarted, {
      toolCallId,
      name: toolName,
      input: { code: "..." },
    }),
  );
}

function finishToolCall(
  projection: ProductProjection,
  toolCallId: string,
  result: Record<string, unknown>,
): void {
  projection.applyEvent(
    baseEvent(SessionEventType.ToolCallResult, {
      toolCallId,
      result: { success: true, content: "ok", ...result },
    }),
  );
}

function findRow(projection: ProductProjection, toolCallId: string) {
  return projection
    .getSnapshot()
    .rows.window.find(
      (row): row is Extract<typeof row, { kind: "toolCall" }> =>
        row.kind === "toolCall" && row.toolCallId === toolCallId,
    );
}

test("js 行携带 cuaApp → row.cuaApp 落位（UI 分组键接通）", () => {
  const projection = new ProductProjection("sess-test", "epoch-1");
  startTurn(projection);
  scheduleToolCall(projection, "call-1", "mcp__node_repl__js");
  finishToolCall(projection, "call-1", {
    cuaApp: { pid: 4242, name: "TextEdit", bundleId: "com.apple.TextEdit" },
  });
  const row = findRow(projection, "call-1");
  assert.ok(row, "toolCall row should exist");
  assert.equal(row.status, "success");
  assert.deepEqual(row.cuaApp, { pid: 4242, name: "TextEdit", bundleId: "com.apple.TextEdit" });
});

test("无 cuaApp 的 js 行（browser-only）不误标", () => {
  const projection = new ProductProjection("sess-test", "epoch-1");
  startTurn(projection);
  scheduleToolCall(projection, "call-2", "mcp__node_repl__js");
  finishToolCall(projection, "call-2", {});
  const row = findRow(projection, "call-2");
  assert.ok(row);
  assert.equal(row.cuaApp, undefined);
});

test("非 js 工具行同样透传（分组按 toolName+字段双门，不受影响）", () => {
  const projection = new ProductProjection("sess-test", "epoch-1");
  startTurn(projection);
  scheduleToolCall(projection, "call-3", "Read");
  finishToolCall(projection, "call-3", { cuaApp: { pid: 1, name: "X" } });
  const row = findRow(projection, "call-3");
  assert.ok(row);
  assert.deepEqual(row.cuaApp, { pid: 1, name: "X" });
});

test("失败结果携带 cuaApp 也落位（错误卡仍可归组）", () => {
  const projection = new ProductProjection("sess-test", "epoch-1");
  startTurn(projection);
  scheduleToolCall(projection, "call-4", "mcp__node_repl__js");
  projection.applyEvent(
    baseEvent(SessionEventType.ToolCallResult, {
      toolCallId: "call-4",
      result: {
        success: false,
        content: "",
        cuaApp: { pid: 999, name: "Safari" },
        error: { type: "fault.runtime", message: "boom" },
      },
    }),
  );
  const row = findRow(projection, "call-4");
  assert.ok(row);
  assert.equal(row.status, "error");
  assert.deepEqual(row.cuaApp, { pid: 999, name: "Safari" });
});
