// ============================================================
// U2-3b（移植自 ZCode 3.15.1，上游 Ves=elidePartForIndex / Hes=elideMessageForIndex /
// Len=elideSessionSnapshotForIndex，zcode.cjs@≈913963 逐函数对照重建）
// ============================================================
// 用途：session/read 的 contentProfile="index" 出口裁剪——会话列表/任务索引回源只
// 需要结构与正文（text part），不需要重载荷。削重目标：reasoning 文本、data: URL、
// tool 各状态的 input/raw/output/error/metadata。坏数据不在此处理（那是 codecs
// 坏行隔离的职责）；text part 永不动（searchableText 只取 text，见 taskIndexSyncer）。

import type { ZCodeSessionStateSnapshot } from "./index.js";
import type { ZCodeMessageWithParts, ZCodeMessagePart } from "../zcode-protocol-legacy-types.js";

const EMPTY_DATA_URL = "data:,";

export type ZCodeSessionContentProfile = "full" | "index";

function elidePartForIndex(part: ZCodeMessagePart): ZCodeMessagePart {
  switch (part.type) {
    case "reasoning":
      return part.text ? { ...part, text: "" } : part;
    case "file":
      return part.url.startsWith("data:") && part.url !== EMPTY_DATA_URL
        ? { ...part, url: EMPTY_DATA_URL }
        : part;
    case "tool": {
      const state = part.state;
      switch (state.status) {
        case "pending":
          return { ...part, state: { ...state, input: {}, raw: "" } };
        case "running":
          return {
            ...part,
            state: { ...state, input: {}, ...(state.metadata ? { metadata: {} } : {}) },
          };
        case "completed":
          return { ...part, state: { ...state, input: {}, output: "", metadata: {} } };
        case "error":
          return {
            ...part,
            state: { ...state, input: {}, error: "", ...(state.metadata ? { metadata: {} } : {}) },
          };
        default:
          return part;
      }
    }
    default:
      return part;
  }
}

function elideMessageForIndex(message: ZCodeMessageWithParts): ZCodeMessageWithParts {
  let changed = false;
  const parts = message.parts.map((part) => {
    const elided = elidePartForIndex(part);
    if (elided !== part) changed = true;
    return elided;
  });
  return changed ? { ...message, parts } : message;
}

/** index 档：返回削重后的新快照（输入不可变）。full 档不经过本函数。 */
export function elideSessionSnapshotForIndex(
  snapshot: ZCodeSessionStateSnapshot,
): ZCodeSessionStateSnapshot {
  return { ...snapshot, messages: snapshot.messages.map(elideMessageForIndex) };
}
