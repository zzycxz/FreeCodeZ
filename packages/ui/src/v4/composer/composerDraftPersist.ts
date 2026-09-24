// 350ms 草稿持久化链的合并语义（B2 闭环提纯，上游 3.14.1/3.14.3 草稿加固口径）。
// 拆包报告 2.2 的唯一有损环节：空文本快照丢 editorStateJson 结构 + 每次合并清
// mention/editorStateJson——重挂载恢复退化为 setText(纯文本)，mention pill 引用丢失。
// 语义提纯为纯函数供 useDraftConfigControl / ConversationComposer 复用与单测锁定。
import type { V4ComposerDraft } from "./composerDraftStore.js";

/**
 * 编辑器现状 → 持久化快照。空文本快照**不**丢 editorStateJson：折叠计划/压缩输入框等
 * 不碰编辑器内容的时机也可能触发一次 persist，若此时按「空文本=空快照」丢结构，
 * 下次重挂载恢复只能走纯文本退化路径。
 */
export function buildComposerPersistSnapshot(
  text: string,
  editorStateJson?: string,
): Pick<V4ComposerDraft, "text" | "editorStateJson"> {
  return { text, ...(editorStateJson ? { editorStateJson } : {}) };
}

/**
 * 快照合并进草稿。非空文本快照默认清掉旧结构（新文本配陈旧 editorStateJson/mention
 * 是错配状态）；空文本快照不携带结构时保留既有结构，只在快照显式给出时覆盖。
 */
export function mergeComposerPersistedContent(
  current: V4ComposerDraft,
  content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">,
): V4ComposerDraft {
  return {
    ...current,
    ...(content.text.trim() ? { editorStateJson: undefined, mention: undefined } : {}),
    ...content,
  };
}
