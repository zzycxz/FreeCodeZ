import type { OutboundBatch } from "@zcode/shared/web-remote-control";

// 重放缓冲（附录A §3.2）：batches[i] 对应 messageSeq = i + 1，headIndex 指向首个未确认槽位；
// releaseThrough 累计释放；compactReleasedPrefix 在 headIndex≥1024 且 headIndex*2≥length 时压缩；
// 缓冲总量 ≤8MB（超出 → replayBufferExceeded），批次超龄 45s 由调用方按场景定 fault 码。

export type EnqueueResult = { ok: true } | { ok: false; reason: "remote.rpcFrame.replayBufferExceeded" };

export interface RelayReplayBuffer {
  enqueue(batch: OutboundBatch): EnqueueResult;
  releaseThrough(messageSeq: number): void;
  unacknowledgedBytes(): number;
  /** visit 返回 false 即中断遍历。 */
  forEachUnacked(visit: (batch: OutboundBatch) => boolean | void): void;
  findOverdueBatch(now: number, graceMs: number): OutboundBatch | null;
  clear(): void;
}

export function createRelayReplayBuffer(options: {
  maxBytes: number;
  now(): number;
}): RelayReplayBuffer {
  let batches: Array<OutboundBatch | undefined> = [];
  let headIndex = 0;
  let unackedBytes = 0;

  function compactReleasedPrefix(): void {
    if (headIndex >= 1024 && headIndex * 2 >= batches.length) {
      batches = batches.slice(headIndex);
      headIndex = 0;
    }
  }

  return {
    enqueue(batch): EnqueueResult {
      if (unackedBytes + batch.outerBytes > options.maxBytes) {
        return { ok: false, reason: "remote.rpcFrame.replayBufferExceeded" };
      }
      batches.push(batch);
      unackedBytes += batch.outerBytes;
      return { ok: true };
    },
    releaseThrough(messageSeq): void {
      while (headIndex < batches.length) {
        const batch = batches[headIndex];
        if (!batch || batch.messageSeq > messageSeq) break;
        batches[headIndex] = undefined;
        unackedBytes = Math.max(0, unackedBytes - batch.outerBytes);
        headIndex += 1;
      }
      compactReleasedPrefix();
    },
    unacknowledgedBytes: () => unackedBytes,
    forEachUnacked(visit): void {
      for (let index = headIndex; index < batches.length; index += 1) {
        const batch = batches[index];
        if (!batch) continue;
        if (visit(batch) === false) return;
      }
    },
    findOverdueBatch(now, graceMs): OutboundBatch | null {
      for (let index = headIndex; index < batches.length; index += 1) {
        const batch = batches[index];
        if (!batch) continue;
        if (now - batch.queuedAt > graceMs) return batch;
      }
      return null;
    },
    clear(): void {
      batches = [];
      headIndex = 0;
      unackedBytes = 0;
    },
  };
}
