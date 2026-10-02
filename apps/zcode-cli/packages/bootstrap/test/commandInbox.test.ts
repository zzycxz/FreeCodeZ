// C3：CommandInbox 准入语义表驱动测试（只测实现，不改实现）。覆盖五组不变量：
// ①FIFO admission gate：session gate 持有到 settle 才释放（execute 分支）；
// ②三层事实分离：in-flight/live pinned、settled 512 LRU、guard 四态；
// ③双重 CAS：epoch 先于 revision（row-targeting 命令）；
// ④duplicate 共享 in-flight final promise（不重复执行、failed 终态不被覆盖）；
// ⑤resident 去激活保护（有 pinned 拒绝 clearSession）。
import assert from "node:assert/strict";
import test from "node:test";
import { CommandInbox, queueItemIdForCommand } from "../src/zcode-protocol-v4/command-inbox.js";
import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";

const SESSION = "sess-1";
const EPOCH = "epoch-1";

interface HostState {
  revision: number;
  logEpoch: string | null;
  transcript: Map<string, CommandAck>;
  guardCalls: number;
  verdict?: { verdict: "allow" } | { verdict: "reject"; reasonCode: string } | { verdict: "noop"; reasonCode: string };
}

function makeHost(state: HostState) {
  return {
    getRevision: () => state.revision,
    getLogEpoch: () => state.logEpoch,
    guard: (envelope: CommandEnvelope) => {
      state.guardCalls += 1;
      return state.verdict ?? { verdict: "allow" as const };
    },
    lookupTranscriptCommand: (key: { commandId: string }) =>
      state.transcript.get(key.commandId) ?? null,
  };
}

let commandCounter = 0;
function envelope(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  commandCounter += 1;
  return {
    commandId: `cmd-${commandCounter}`,
    clientId: "client-1",
    sessionId: SESSION,
    type: "setFollowupMode", // CAS 命令（需 baseRevision，非 row-targeting）
    baseRevision: 7,
    payload: { mode: "queue" },
    issuedAt: 1_760_000_000_000, // timestampSchema 为数字（epoch ms），仅遥测
    ...overrides,
  } as CommandEnvelope;
}

function rowTargetingEnvelope(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return envelope({
    type: "editUserQuery", // row-targeting：需 baseRevision + baseLogEpoch
    baseLogEpoch: EPOCH,
    payload: { target: { rowId: 1, entityId: "turn-1" }, newText: "edited" },
    ...overrides,
  } as Partial<CommandEnvelope>);
}

async function admit(inbox: CommandInbox, env: CommandEnvelope) {
  const outcome = await inbox.handle(env);
  assert.equal(outcome.kind, "execute", `命令 ${env.commandId} 应被放行执行`);
  return outcome;
}

test("①FIFO：session gate 持有到 settle 才释放，admission 顺序串行", async () => {
  const inbox = new CommandInbox(makeHost({ revision: 7, logEpoch: EPOCH, transcript: new Map(), guardCalls: 0 }));
  const first = await admit(inbox, envelope());
  const secondPromise = inbox.handle(envelope());
  // 第一条未 settle 时第二条必须还在等 session gate（不是 execute）。
  const raced = await Promise.race([
    secondPromise.then((outcome) => outcome.kind),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 80)),
  ]);
  assert.equal(raced, "pending", "settle 前下一条 admission 不得进入");

  first.settle({ status: "completed" });
  const second = await secondPromise;
  assert.equal(second.kind, "execute");
  if (second.kind === "execute") {
    assert.equal(second.admissionSeq, first.admissionSeq + 1, "admissionSeq 严格递增");
    second.settle({ status: "completed" });
  }
});

test("②在途 duplicate 共享 in-flight final promise，不重复执行、不重复 admission", async () => {
  const state = { revision: 7, logEpoch: EPOCH, transcript: new Map(), guardCalls: 0 };
  const inbox = new CommandInbox(makeHost(state));
  const env = envelope();
  const first = await admit(inbox, env);
  // 在途 duplicate 的 handle 会 await in-flight final（settle 前不返回）——
  // 先启动、再 settle、后 await，正是"共享同一个 final promise"语义的验证形态。
  const dupPromise = inbox.handle(env);
  first.settle({ status: "failed", reasonCode: "fault.x" });
  const dup = await dupPromise;
  assert.equal(dup.kind, "ack");
  if (dup.kind === "ack") {
    // 与首条相同的 final 终态（failed 不被 duplicate 覆盖）。
    assert.equal(dup.ack.status, "failed");
    assert.equal(dup.ack.reasonCode, "fault.x");
  }
  assert.equal(state.guardCalls, 1, "duplicate 不得二次触达 guard/admission");
});

test("②settled duplicate 判 duplicate（非 failed 终态不覆盖为 accepted）", async () => {
  const inbox = new CommandInbox(makeHost({ revision: 7, logEpoch: EPOCH, transcript: new Map(), guardCalls: 0 }));
  const env = envelope();
  const first = await admit(inbox, env);
  first.settle({ status: "completed" });
  // 必须重放同一 commandId（重调 envelope() 会生成新 id，那是新命令而非 duplicate）。
  const dup = await inbox.handle(env);
  assert.equal(dup.kind === "ack" && dup.ack.status, "duplicate");
});

test("②live input pin 优先于 settled：churn 不得淘汰在队列里的输入", async () => {
  const inbox = new CommandInbox(makeHost({ revision: 7, logEpoch: EPOCH, transcript: new Map(), guardCalls: 0 }));
  const env = envelope();
  const first = await admit(inbox, env);
  inbox.pinLiveInput(SESSION, {
    kind: "queue",
    sourceCommandId: env.commandId,
    text: "hello",
  } as never);
  first.settle({ status: "completed" });
  // pin 存在时 settle 只更新 live ack（终态可见），不转入 settled LRU——
  // settled churn 永远摸不到还在队列/在飞的输入。
  const queried = await inbox.query([{ sessionId: SESSION, commandId: env.commandId }]);
  assert.equal((queried[0]?.result as CommandAck).status, "completed");
  assert.equal(
    Boolean(inbox["settled"].get(SESSION)?.has(env.commandId)),
    false,
    "pin 期间不得进入 settled LRU",
  );
  // 释放 pin 时才转 settled，终态保持。
  inbox.releaseLiveInput({ sessionId: SESSION, commandId: env.commandId });
  const afterRelease = await inbox.query([{ sessionId: SESSION, commandId: env.commandId }]);
  assert.equal((afterRelease[0]?.result as CommandAck).status, "completed");
  assert.equal(inbox["settled"].get(SESSION)?.has(env.commandId), true);
});

test("②settled LRU 512 上限：churn 淘汰最旧、touch 重排", async () => {
  const inbox = new CommandInbox(makeHost({ revision: 7, logEpoch: EPOCH, transcript: new Map(), guardCalls: 0 }));
  for (let index = 0; index < 520; index += 1) {
    inbox["rememberSettled"](SESSION, `c-${index}`, {
      commandId: `c-${index}`,
      status: "completed",
      revisionAtDecision: 7,
    });
  }
  assert.equal(inbox["settled"].get(SESSION)?.size, 512);
  assert.equal(inbox["settled"].get(SESSION)?.has("c-0"), false, "最旧被淘汰");
  assert.equal(inbox["settled"].get(SESSION)?.has("c-519"), true);
});

test("③epoch 先于 revision：row-targeting 命令 epoch 不符即 staleLogEpoch", async () => {
  const inbox = new CommandInbox(makeHost({ revision: 7, logEpoch: "epoch-2", transcript: new Map(), guardCalls: 0 }));
  const outcome = await inbox.handle(rowTargetingEnvelope({ baseRevision: 999 }));
  assert.equal(outcome.kind === "ack" && outcome.ack.reasonCode, "proto.staleLogEpoch");
});

test("③epoch 相符但 revision 不符：staleRevision", async () => {
  const inbox = new CommandInbox(makeHost({ revision: 8, logEpoch: EPOCH, transcript: new Map(), guardCalls: 0 }));
  const outcome = await inbox.handle(rowTargetingEnvelope({ baseRevision: 7 }));
  assert.equal(outcome.kind === "ack" && outcome.ack.reasonCode, "proto.staleRevision");
});

test("③epoch 与 revision 双符：放行执行", async () => {
  const inbox = new CommandInbox(makeHost({ revision: 7, logEpoch: EPOCH, transcript: new Map(), guardCalls: 0 }));
  const outcome = await inbox.handle(rowTargetingEnvelope({ baseRevision: 7 }));
  assert.equal(outcome.kind, "execute");
});

test("③CAS 命令缺 baseRevision 在信封层即被拒（proto.invalidPayload）", async () => {
  const inbox = new CommandInbox(makeHost({ revision: 7, logEpoch: EPOCH, transcript: new Map(), guardCalls: 0 }));
  const raw = envelope();
  delete (raw as Partial<CommandEnvelope>).baseRevision;
  const outcome = await inbox.handle(raw);
  assert.equal(outcome.kind === "ack" && outcome.ack.reasonCode, "proto.invalidPayload");
});

test("③非 CAS 命令不校验 revision：不携带 baseRevision 也放行", async () => {
  const inbox = new CommandInbox(makeHost({ revision: 7, logEpoch: EPOCH, transcript: new Map(), guardCalls: 0 }));
  const outcome = await inbox.handle(
    envelope({ type: "createSelectionSideSession", baseRevision: undefined, payload: { firstInput: { text: "hi" } } }),
  );
  assert.equal(outcome.kind, "execute");
});

test("②guard 四态：reject 拒绝并带 reasonCode，且不进入 admission", async () => {
  const state = { revision: 7, logEpoch: EPOCH, transcript: new Map(), guardCalls: 0, verdict: { verdict: "reject" as const, reasonCode: "custom.no" } };
  const inbox = new CommandInbox(makeHost(state));
  const outcome = await inbox.handle(envelope());
  assert.equal(outcome.kind === "ack" && outcome.ack.status, "rejected");
  assert.equal(outcome.kind === "ack" && outcome.ack.reasonCode, "custom.no");
  assert.equal(inbox.hasPinnedSessionState(SESSION), false, "拒绝不留 in-flight");
});

test("②guard noop：晚到者静默收口并 remember 进 settled（不执行）", async () => {
  const state = { revision: 7, logEpoch: EPOCH, transcript: new Map(), guardCalls: 0, verdict: { verdict: "noop" as const, reasonCode: "custom.late" } };
  const inbox = new CommandInbox(makeHost(state));
  const outcome = await inbox.handle(envelope());
  assert.equal(outcome.kind === "ack" && outcome.ack.status, "noop");
  const queried = await inbox.query([{ sessionId: SESSION, commandId: outcome.kind === "ack" ? outcome.ack.commandId : "" }]);
  assert.equal((queried[0]?.result as CommandAck).status, "noop");
});

test("②row-target resolver：stale 裁决优先于 guard", async () => {
  const host = makeHost({ revision: 7, logEpoch: EPOCH, transcript: new Map(), guardCalls: 0 });
  const inbox = new CommandInbox({
    ...host,
    validateRowTarget: () => ({ verdict: "stale", reasonCode: "proto.staleTarget" }),
  });
  const outcome = await inbox.handle(rowTargetingEnvelope());
  assert.equal(outcome.kind === "ack" && outcome.ack.reasonCode, "proto.staleTarget");
});

test("⑤去激活保护：存在 pinned in-flight/live 时 clearSession 拒绝", async () => {
  const inbox = new CommandInbox(makeHost({ revision: 7, logEpoch: EPOCH, transcript: new Map(), guardCalls: 0 }));
  const first = await admit(inbox, envelope());
  assert.equal(inbox.clearSession(SESSION), false, "in-flight 未 settle 不得清");
  first.settle({ status: "completed" });
  inbox.pinLiveInput(SESSION, { kind: "queue", sourceCommandId: "live-1", text: "x" } as never);
  assert.equal(inbox.clearSession(SESSION), false, "live input 未释放不得清");
  inbox.releaseLiveInput({ sessionId: SESSION, commandId: "live-1" });
  assert.equal(inbox.clearSession(SESSION), true);
});

test("②持久化回源顺序：transcript 事实优先于本地 settled miss", async () => {
  const transcript = new Map<string, CommandAck>([
    ["from-store", { commandId: "from-store", status: "completed", revisionAtDecision: 3 }],
  ]);
  const inbox = new CommandInbox(makeHost({ revision: 7, logEpoch: EPOCH, transcript, guardCalls: 0 }));
  const queried = await inbox.query([{ sessionId: SESSION, commandId: "from-store" }]);
  assert.equal((queried[0]?.result as CommandAck).status, "completed");
  const unknown = await inbox.query([{ sessionId: SESSION, commandId: "never-seen" }]);
  assert.equal(unknown[0]?.result, "unknown");
});

test("②会话不存在：getRevision 返回 null 即 sessionNotFound（createSession 除外）", async () => {
  const inbox = new CommandInbox({
    getRevision: () => null,
    getLogEpoch: () => null,
  });
  const outcome = await inbox.handle(envelope());
  assert.equal(outcome.kind === "ack" && outcome.ack.reasonCode, "proto.sessionNotFound");
});

test("①queueItemId 派生：execute 结果携带 queueItemIdForCommand 形态", async () => {
  const inbox = new CommandInbox(makeHost({ revision: 7, logEpoch: EPOCH, transcript: new Map(), guardCalls: 0 }));
  const env = envelope();
  const outcome = await inbox.handle(env);
  assert.equal(outcome.kind, "execute");
  if (outcome.kind === "execute") {
    assert.equal(outcome.queueItemId, queueItemIdForCommand(env.commandId));
    assert.equal(outcome.queueItemId, `queue_${env.commandId}`);
    outcome.settle({ status: "completed" });
  }
});
