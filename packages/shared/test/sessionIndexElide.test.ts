// U2-3b（移植自 ZCode 3.15.1）session/read index 档出口削重纯件测试：
// reasoning 文本清空、data: URL 归一、tool 载荷按状态剥空；text part 与其余 part 不动。
import assert from "node:assert/strict";
import test from "node:test";
import { elideSessionSnapshotForIndex } from "../src/zcode-protocol/session-index-elide.js";
import type { ZCodeSessionStateSnapshot } from "../src/zcode-protocol/index.js";
import type { ZCodeMessageWithParts } from "../src/zcode-protocol-legacy-types.js";

function messageWith(parts: ZCodeMessageWithParts["parts"]): ZCodeMessageWithParts {
  return {
    info: { id: "m1", role: "assistant", sessionID: "s1" } as ZCodeMessageWithParts["info"],
    parts,
  };
}

function snapshotWith(messages: ZCodeMessageWithParts[]): ZCodeSessionStateSnapshot {
  return {
    protocol: { name: "zcode", version: 4 },
    session: {} as ZCodeSessionStateSnapshot["session"],
    settings: {} as ZCodeSessionStateSnapshot["settings"],
    projection: {} as ZCodeSessionStateSnapshot["projection"],
    runtime: {} as ZCodeSessionStateSnapshot["runtime"],
    messages,
  } as unknown as ZCodeSessionStateSnapshot;
}

test("reasoning 非空文本清空，text part 不动", () => {
  const snapshot = snapshotWith([
    messageWith([
      { id: "p1", type: "reasoning", text: "内部思考" } as ZCodeMessageWithParts["parts"][number],
      { id: "p2", type: "text", text: "正文保留" } as ZCodeMessageWithParts["parts"][number],
    ]),
  ]);
  const elided = elideSessionSnapshotForIndex(snapshot);
  const parts = elided.messages[0]?.parts ?? [];
  assert.equal(parts[0]?.type === "reasoning" ? parts[0].text : undefined, "");
  assert.equal(parts[1]?.type === "text" ? parts[1].text : undefined, "正文保留");
});

test("file 的 data: URL 归一为 data:,，http URL 不动", () => {
  const snapshot = snapshotWith([
    messageWith([
      { id: "p1", type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" } as ZCodeMessageWithParts["parts"][number],
      { id: "p2", type: "file", mime: "text/html", url: "https://example.com/x.html" } as ZCodeMessageWithParts["parts"][number],
    ]),
  ]);
  const parts = elideSessionSnapshotForIndex(snapshot).messages[0]?.parts ?? [];
  assert.equal(parts[0]?.type === "file" ? parts[0].url : undefined, "data:,");
  assert.equal(parts[1]?.type === "file" ? parts[1].url : undefined, "https://example.com/x.html");
});

test("tool 各状态载荷剥空（input/raw/output/error/metadata），保留时间戳等结构", () => {
  const snapshot = snapshotWith([
    messageWith([
      {
        id: "p1",
        type: "tool",
        callId: "c1",
        tool: "bash",
        state: { status: "pending", input: { cmd: "ls" }, raw: "ls" },
      } as ZCodeMessageWithParts["parts"][number],
      {
        id: "p2",
        type: "tool",
        callId: "c2",
        tool: "bash",
        state: {
          status: "completed",
          input: { cmd: "ls" },
          output: "大输出".repeat(100),
          title: "t",
          metadata: { big: "payload" },
          startedAt: 1,
          completedAt: 2,
        },
      } as ZCodeMessageWithParts["parts"][number],
      {
        id: "p3",
        type: "tool",
        callId: "c3",
        tool: "bash",
        state: { status: "error", input: { cmd: "x" }, error: " boom ", startedAt: 1, completedAt: 2 },
      } as ZCodeMessageWithParts["parts"][number],
    ]),
  ]);
  const parts = elideSessionSnapshotForIndex(snapshot).messages[0]?.parts ?? [];
  const pending = parts[0]?.type === "tool" ? parts[0].state : undefined;
  assert.deepEqual(pending?.status === "pending" ? pending.input : undefined, {});
  assert.equal(pending?.status === "pending" ? pending.raw : undefined, "");
  const completed = parts[1]?.type === "tool" ? parts[1].state : undefined;
  assert.equal(completed?.status === "completed" ? completed.output : undefined, "");
  assert.deepEqual(completed?.status === "completed" ? completed.metadata : undefined, {});
  assert.equal(completed?.status === "completed" ? completed.completedAt : undefined, 2);
  const errored = parts[2]?.type === "tool" ? parts[2].state : undefined;
  assert.equal(errored?.status === "error" ? errored.error : undefined, "");
});

test("无重载荷的快照：messages 数组为新对象但 message/part 引用保持不变", () => {
  const message = messageWith([
    { id: "p1", type: "text", text: "only" } as ZCodeMessageWithParts["parts"][number],
  ]);
  const snapshot = snapshotWith([message]);
  const elided = elideSessionSnapshotForIndex(snapshot);
  assert.notEqual(elided, snapshot);
  assert.equal(elided.messages[0], message);
});
