// B2 闭环：350ms 草稿持久化链合并语义单测（上游 3.14.1/3.14.3 草稿加固口径，
// 见 upstream-assets 拆包报告 2.2 与 docs/spec/upstream-fix-port-batches-0-1.md）。
// 锁定三条不变量：空快照保结构、非空快照防错配清旧结构、显式携带优先。
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildComposerPersistSnapshot,
  mergeComposerPersistedContent,
} from "../src/v4/composer/composerDraftPersist.js";
import type { V4ComposerDraft } from "../src/v4/composer/composerDraftStore.js";

const draft = (patch: Partial<V4ComposerDraft>): V4ComposerDraft =>
  ({ text: "", ...patch }) as V4ComposerDraft;

test("快照：空文本 + 有 editorState 结构 → 保留结构（不退化为纯文本）", () => {
  assert.deepEqual(buildComposerPersistSnapshot("", '{"root":{}}'), {
    text: "",
    editorStateJson: '{"root":{}}',
  });
});

test("快照：空文本 + 无结构 → 只有 text；非空文本同形", () => {
  assert.deepEqual(buildComposerPersistSnapshot(""), { text: "" });
  assert.deepEqual(buildComposerPersistSnapshot("hello", undefined), { text: "hello" });
  assert.deepEqual(buildComposerPersistSnapshot("hello", '{"root":{}}'), {
    text: "hello",
    editorStateJson: '{"root":{}}',
  });
});

test("合并：空文本快照（折叠/压缩时机）不清既有 mention/editorStateJson", () => {
  const current = draft({
    text: "旧文本",
    editorStateJson: '{"mention":"plugin://x"}',
    mention: "plugin://x",
  });
  const next = mergeComposerPersistedContent(current, { text: "  " });
  assert.equal(next.editorStateJson, '{"mention":"plugin://x"}');
  assert.equal(next.mention, "plugin://x");
});

test("合并：非空文本快照不带结构（序列化失败）→ 清旧结构防错配", () => {
  const current = draft({
    text: "旧文本",
    editorStateJson: '{"stale":true}',
    mention: "plugin://old",
  });
  const next = mergeComposerPersistedContent(current, { text: "新文本" });
  assert.equal(next.editorStateJson, undefined);
  assert.equal(next.mention, undefined);
  assert.equal(next.text, "新文本");
});

test("合并：快照显式携带新结构 → 覆盖旧值（空/非空文本同规则）", () => {
  const current = draft({ editorStateJson: '{"old":1}', mention: "plugin://old" });
  assert.equal(
    mergeComposerPersistedContent(current, { text: "", editorStateJson: '{"new":2}' })
      .editorStateJson,
    '{"new":2}',
  );
  assert.equal(
    mergeComposerPersistedContent(current, {
      text: "新文本",
      editorStateJson: '{"new":3}',
      mention: "plugin://new",
    }).mention,
    "plugin://new",
  );
});
