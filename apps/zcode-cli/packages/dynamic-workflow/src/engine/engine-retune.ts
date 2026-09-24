// ============================================================
// 原地 retune 的引擎逻辑（批次 2-1 / 上游 3.14.3 R3）
// ============================================================
// 从 engine.ts 拆出（max-lines 门）：引擎类只留一行委托，语义全部在这里。
// 与上游 3.14.3 的 setMaxConcurrency 等价：runId 不变、不起后继、在飞 ask 不动；
// 升档 pumpAll 放行排队，降档只影响后续派发。终态/非有限值拒绝（false）。
// journal 是事实源：先 UPDATE caps 列、再发 `run-caps-changed`（投影据此抬
// concurrency.limit）；同值幂等（true 且不落库不发声，扛恢复重放期的重复调用）。

import type { EngineState } from "./engine-state.js";

/** retune 走引擎的 state 接缝（兄弟模块自由函数读写私有状态的既有先例），纯逻辑可单测。 */
export function retuneEngineCaps(state: EngineState, requested: number): boolean {
  if (state.isRunSettled() || !Number.isFinite(requested)) return false;
  const next = Math.max(1, Math.floor(requested));
  const previous = state.caps.maxConcurrency;
  if (next === previous) return true;
  // caps 对象与 scheduler host 共享引用：原地改让门禁读点（pumpActor 的
  // activeAsks >= caps.maxConcurrency）即时生效，无需另设广播。
  state.caps.maxConcurrency = next;
  state.journal.updateRunCaps(state.runId, state.caps);
  state.record({ type: "run-caps-changed", runId: state.runId, caps: { ...state.caps }, previous });
  if (next > previous) state.pumpAll();
  return true;
}
