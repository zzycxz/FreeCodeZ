// 0B-1 修复测试（升级实施手册）：会话行懒落库完成前写 session_entries（外键指向 sessions）
// 必触发 FOREIGN KEY constraint failed。两个无守卫写入者：
// ① core turn-model persistRuntimeModelSelection（首轮流内定选型）；
// ② bootstrap session-facade persistSessionModelSelection（create 后立即切模型）。
// 修复语义：行未落地→跳过（选型已在内存，懒落库回写兜底）；行在→照写。
// 查询侧：live 会话无行时 listSessionSubagents 返回空列表而非 sessionUnavailable。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { persistRuntimeModelSelection } from "../src/runtime/methods/turn-model.js";

const here = dirname(fileURLToPath(import.meta.url));

interface FakeRuntime {
  sessionId: string;
  sessionStore: { saveSessionEntry: (entry: unknown) => Promise<void> };
  sessionPersisted: boolean;
  logger?: { warn: () => void };
}

function fakeRuntime(persisted: boolean, writes: unknown[]): FakeRuntime {
  return {
    sessionId: "sess_test",
    sessionPersisted: persisted,
    sessionStore: {
      saveSessionEntry: async (entry: unknown) => {
        writes.push(entry);
      },
    },
  };
}

test("守卫：会话行未落地时跳过写入（不触发 FK）", async () => {
  const writes: unknown[] = [];
  await persistRuntimeModelSelection(fakeRuntime(false, writes) as never, {
    providerId: "glm",
    modelId: "glm-4.7",
  });
  assert.equal(writes.length, 0, "懒落库窗口内不得写 session_entries");
});

test("守卫：会话行已落地时照常写入", async () => {
  const writes: unknown[] = [];
  await persistRuntimeModelSelection(fakeRuntime(true, writes) as never, {
    providerId: "glm",
    modelId: "glm-4.7",
  });
  assert.equal(writes.length, 1);
  assert.deepEqual((writes[0] as { id: string }).id, "sess_test:runtime-model-selection");
});

test("守卫：rowExists 自证（懒落库回写路径）绕过窗口检查", async () => {
  const writes: unknown[] = [];
  await persistRuntimeModelSelection(
    fakeRuntime(false, writes) as never,
    { providerId: "glm", modelId: "glm-4.7" },
    { rowExists: true },
  );
  assert.equal(writes.length, 1, "回写路径行刚建好，必须写入");
});

test("锚定：懒落库回写传 rowExists 且经同一函数（不旁路出第二实现）", () => {
  const source = readFileSync(join(here, "../src/runtime/methods/events.ts"), "utf8");
  assert.match(
    source,
    /persistRuntimeModelSelection\(this,\s*initialSelection,\s*\{\s*rowExists:\s*true\s*\}\)/,
    "ensureSessionPersisted 回写必须 rowExists 自证，防未来改回无守卫调用",
  );
});

test("锚定：bootstrap 侧写入者（session-facade）同款守卫", () => {
  const source = readFileSync(
    join(here, "../../../packages/bootstrap/src/app/session-facade.ts"),
    "utf8",
  );
  assert.match(
    source,
    /if \(!deps\.runtime\.isSessionPersisted\(\)\) return;/,
    "persistSessionModelSelection 必须有会话行守卫（0B-1 回归锚）",
  );
});

test("锚定：查询侧对 live 未落库会话返回空列表而非抛错", () => {
  const source = readFileSync(
    join(here, "../../../packages/bootstrap/src/zcode-protocol/server-operations.ts"),
    "utf8",
  );
  const emptyShapeMatch =
    /if \(liveParent\) \{\s*return \{\s*revision: liveParent\.stateRevision \?\? 0,/.exec(source);
  assert.ok(emptyShapeMatch, "listSessionSubagents 的懒落库窗口必须返回空形状");
  assert.ok(
    emptyShapeMatch.index < source.indexOf('"ZCode Protocol session subagents has no persisted parent"'),
    "空形状分支必须在 persisted_missing 告警之前（live 会话不该走到告警）",
  );
});
