// ============================================================
// actor 会话静默探测（批次 2-2 carry / 上游 3.14.3 createActorSessionQuiescence）
// ============================================================
// 修订停掉在飞前驱的那一刻，前驱的 actor 会话可能还有一轮模型输出在落库（turn promise 未
// 兑现）。携带判定要拿「源会话此刻的**全量**消息数」当在飞边界——数在一个还在增长的流上取，
// 拿到的就是个移动靶。本模块按会话记下各自的 turn promise，amend 在前驱结算后、建缓存前
// 有界地等它们落地（缺省 5000ms）：到点的会话进 quiet 集合，没到点的**不进**——
// resolveInFlightAsk 对不在集合里的会话放弃携带（session_not_quiescent），绝不拿一个
// 还在变的计数当边界。超时不是失败，只是放弃。

/** 有界等待的缺省上限；等满即放弃（该会话不进 quiet 集合）。 */
const DEFAULT_QUIESCE_MS = 5000;

export interface ActorSessionQuiescence {
  /** run 结算释放会话时逐会话登记：turn 在飞就递 turn promise，否则 undefined。 */
  noteDisposed(sessionId: string, turn: Promise<unknown> | undefined): void;
  /** 有界等待所有已登记会话的 turn 落地；返回已静默的会话集合（未到点的不在）。 */
  quietSessions(): Promise<Set<string>>;
}

export function createActorSessionQuiescence(options?: {
  quiesceMs?: number;
}): ActorSessionQuiescence {
  const pending = new Map<string, Promise<unknown> | undefined>();
  const quiesceMs = options?.quiesceMs ?? DEFAULT_QUIESCE_MS;
  return {
    noteDisposed(sessionId, turn) {
      pending.set(sessionId, turn);
    },
    async quietSessions() {
      const quiet = new Set<string>();
      const waits: Promise<unknown>[] = [];
      for (const [sessionId, turn] of pending) {
        if (turn === undefined) {
          quiet.add(sessionId);
          continue;
        }
        // 落地即静默；失败同理（turn 拒绝也会把该写的都写完或干脆不写，流结束了）。
        waits.push(
          turn.then(
            () => quiet.add(sessionId),
            () => quiet.add(sessionId),
          ),
        );
      }
      if (waits.length > 0) await settleWithin(Promise.all(waits), quiesceMs);
      return quiet;
    },
  };
}

/** 有界等待：到点 resolve（带 undefined 载荷），底层 promise 的拒绝被 all-catch 吞掉。 */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    void promise.finally(() => clearTimeout(timer)).then(
      () => resolve(undefined),
      () => resolve(undefined),
    );
  });
}
