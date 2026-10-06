// ============================================================
// Phase 2 干预闭环（升级实施手册 v4.2 挂账收口）：动作面用户活动闸
// ============================================================
// 规格后半段："用户动真鼠标 → 暂停 → 等静默后才续跑（防误操作）"。
// HUD 层只做视觉暂停（desktop cuaCursorHud：冻结动画+停帧，静默 800ms 即恢复显示）；
// 本件是执行侧——agent 子进程内、每个动作方法执行前等待用户静默：
//   - 检测复用 cursor-animation.readUserMouseActivity（CGEventSourceSecondsSinceMouseMoved
//     轮询，零 TCC、零 EventTap 崩溃面）；
//   - 持续活跃超过 maxWaitMs → fail-closed 返回结构化 user_active 错误（可重试，不熔断——
//     agent 收到后等用户闲下来重试即可，能力不被禁用）；
//   - 检测器缺席（lastMoveMs undefined，如 CG 调用异常）→ 放行：干预面缺席不折断动作本体
//     （与 HUD 侧 readUserMouseActivity 失败恒不活跃同款语义）。
// 元素类动作的"重查 AX"由既有 stale_element/ax_error 路径承担（元素失效时 AX 调用自然
// 失败，agent 重捕获）；点类动作的时效性由闸门（等待静默）+agent 下一步重捕获共同保证。

import { readUserMouseActivity, USER_MOUSE_ACTIVITY_THRESHOLD_MS } from "./cursor-animation.js";

/** 闸门缺省参数：静默阈值直接复用 HUD 同源常量（防两处漂移——HUD 与动作闸的"用户活跃"必须同义）。 */
export const USER_ACTIVITY_GATE_DEFAULTS = {
  thresholdMs: USER_MOUSE_ACTIVITY_THRESHOLD_MS,
  pollMs: 100,
  maxWaitMs: 30_000,
};

/**
 * 纯判定：一轮观测后闸门该做什么。
 *   proceed —— 已静默（或检测器缺席）→ 放行；
 *   wait    —— 用户活跃且未等满 → 下一轮；
 *   fail    —— 用户持续活跃等到上限 → 结构化失败。
 */
export function userActivityGateDecision(lastMoveMs, waitedMs, options) {
  const { thresholdMs, maxWaitMs } = options;
  if (lastMoveMs === undefined) return "proceed";
  if (lastMoveMs >= thresholdMs) return "proceed";
  if (waitedMs >= maxWaitMs) return "fail";
  return "wait";
}

/**
 * 等待用户静默（异步轮询，readActivity 可注入供测试）。
 * 返回 { ok: true } 或 { ok: false, error: { code: "user_active", ... } }。
 */
export async function waitForUserQuiet(readActivity, options = {}) {
  const opts = { ...USER_ACTIVITY_GATE_DEFAULTS, ...options };
  const startedAt = Date.now();
  for (;;) {
    const { lastMoveMs } = readActivity();
    const decision = userActivityGateDecision(lastMoveMs, Date.now() - startedAt, opts);
    if (decision === "proceed") return { ok: true };
    if (decision === "fail") {
      return {
        ok: false,
        error: {
          code: "user_active",
          message: "user is actively using the mouse; retry after the user goes quiet",
          details: { waited_ms: Date.now() - startedAt, last_move_ms: lastMoveMs },
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs));
  }
}

/**
 * 装饰器：给动作方法表统一套上用户活动闸（仅包 names 里实际存在的函数）。
 * 闸门失败时方法不执行，直接返回结构化错误。
 */
export function wrapMethodsWithActivityGate(methods, names, readActivity, options) {
  for (const name of names) {
    const impl = methods[name];
    if (typeof impl !== "function") continue;
    methods[name] = async (params) => {
      const quiet = await waitForUserQuiet(readActivity, options);
      if (!quiet.ok) return quiet;
      return impl(params);
    };
  }
  return methods;
}

/** 缺省读取器：bindings 取自 loadKoffiBindings()（含 .koffi 模块句柄）。 */
export function createUserActivityReader(bindings) {
  return () => readUserMouseActivity(bindings);
}
