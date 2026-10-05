// ============================================================
// Phase 3a：双击修饰键检测（升级实施手册 桌面控制 3a：热键 ⌘⌘/⌥⌥/⇧⇧）
// ============================================================
// 实现：轮询 CGEventSourceKeyState（读按键态，无需 Event Tap/额外 TCC——
// 与 CGEventTap 回调注册相比零崩溃面）30ms 一拍，状态机识别"两次完整按下-抬起"。
// 状态机为纯函数（nextDoubleTapState）钉测试；poller 只是它的驱动壳。

import { loadKoffiBindings } from "./koffi-ax.js";

export const DOUBLE_TAP_POLL_INTERVAL_MS = 30;
/** 双击窗口：两次按下-抬起的完整间隔上限。 */
export const DOUBLE_TAP_WINDOW_MS = 450;
/** 触发后的静默期（防三击连发）。 */
export const DOUBLE_TAP_REFRACTORY_MS = 800;

/** 虚拟键码（HIToolbox Events.h；左右修饰键成对，任一按下即算按下）。 */
export const MODIFIER_KEY_CODES = Object.freeze({
  cmd: [55, 54],
  alt: [58, 61],
  shift: [56, 60],
});

/**
 * 双击状态机（纯）。
 * 状态：idle（未按）→ armed（第一击完成，等第二击）→ idle（触发 or 超窗）。
 * triggered=true 表示本次 update 恰好完成第二击的抬起。
 */
export function nextDoubleTapState(state, isDown, now, options = {}) {
  const windowMs = options.windowMs ?? DOUBLE_TAP_WINDOW_MS;
  const refractoryMs = options.refractoryMs ?? DOUBLE_TAP_REFRACTORY_MS;
  const current = state ?? { phase: "idle", lastReleaseAt: undefined, lastTriggerAt: undefined };

  if (current.phase === "refractory" && current.lastTriggerAt !== undefined && now - current.lastTriggerAt < refractoryMs) {
    // 静默期内忽略一切（包括持续按住）。
    return { state: current, triggered: false };
  }

  if (isDown) {
    return { state: { ...current, phase: current.phase === "idle" ? "pressed" : "pressed2" }, triggered: false };
  }

  // 抬起沿。
  if (current.phase === "pressed") {
    return {
      state: { phase: "armed", lastReleaseAt: now, lastTriggerAt: current.lastTriggerAt },
      triggered: false,
    };
  }
  if (current.phase === "pressed2") {
    const armedAt = current.lastReleaseAt;
    if (armedAt !== undefined && now - armedAt <= windowMs) {
      return {
        state: { phase: "refractory", lastReleaseAt: undefined, lastTriggerAt: now },
        triggered: true,
      };
    }
    // 第二击太晚：当作新的一击重新 armed。
    return {
      state: { phase: "armed", lastReleaseAt: now, lastTriggerAt: current.lastTriggerAt },
      triggered: false,
    };
  }

  // armed/idle/refractory(已过静默) 的持续松开：armed 超窗回落 idle。
  if (current.phase === "armed" && current.lastReleaseAt !== undefined && now - current.lastReleaseAt > windowMs) {
    return { state: { phase: "idle", lastReleaseAt: undefined, lastTriggerAt: current.lastTriggerAt }, triggered: false };
  }
  if (current.phase === "refractory") {
    return { state: { phase: "idle", lastReleaseAt: undefined, lastTriggerAt: current.lastTriggerAt }, triggered: false };
  }
  return { state: current, triggered: false };
}

/**
 * 修饰键轮询器：按 intervalMs 读 CGEventSourceKeyState（kCGEventSourceStateCombinedSessionState=0），
 * 任一码按下即 down。触发 onTrigger（异常吞掉——热键层不崩主进程）。
 * 返回 stop()。koffi 不可用 → 立即返回 no-op（设置开了也无源）。
 */
export function createModifierDoubleTapWatcher(options) {
  const {
    modifier,
    onTrigger,
    intervalMs = DOUBLE_TAP_POLL_INTERVAL_MS,
    platform = process.platform,
    loadBindings = loadKoffiBindings,
  } = options;
  if (platform !== "darwin") {
    return { stop: () => undefined, available: false };
  }
  const bindings = loadBindings();
  if (!bindings) {
    return { stop: () => undefined, available: false };
  }
  const codes = MODIFIER_KEY_CODES[modifier];
  if (!codes) {
    return { stop: () => undefined, available: false };
  }
  let CG;
  try {
    CG = bindings.koffi.load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
  } catch {
    return { stop: () => undefined, available: false };
  }
  const keyState = CG.func("CGEventSourceKeyState", "bool", ["uint32", "uint32"]);
  let state;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    let isDown = false;
    try {
      isDown = codes.some((code) => keyState(0, code));
    } catch {
      return;
    }
    const result = nextDoubleTapState(state, isDown, Date.now());
    state = result.state;
    if (result.triggered) {
      try {
        onTrigger();
      } catch {
        // 触发面异常不崩轮询器。
      }
    }
  }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    available: true,
  };
}
