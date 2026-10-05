// ============================================================
// Phase 1-c：AX 动作面——click / type / scroll / key / set_value / perform_action
// （升级实施手册 桌面控制 Phase 1；动作阶段开关后启用）
// ============================================================
// 纪律：
//   - 合成输入只在 P1-d 的阶段开关显式放行后被 broker 调用；本模块自身不做权限裁决。
//   - 每个 CGEvent 走 CFRelease try-finally；错误折成结构化结果不 throw。
//   - a11y 策略优先于 event 策略（AXPerformAction 是系统语义，比坐标合成稳）。

import {
  loadKoffiBindings,
  withCFString,
  cfStringToJs,
  cfArrayToRefs,
  describeAxError,
  AXError,
} from "./koffi-ax.js";

const kCGHIDEventTap = 0;
const kCGSessionEventTap = 1;
const kCGEventSourceHIDSystemState = 0;
// CGEventType（鼠标/键盘子集）
const kCGEventMouseMoved = 5;
const kCGEventLeftMouseDown = 1;
const kCGEventLeftMouseUp = 2;
const kCGEventRightMouseDown = 3;
const kCGEventRightMouseUp = 4;
const kCGEventOtherMouseDown = 25;
const kCGEventOtherMouseUp = 26;
const kCGEventKeyDown = 10;
const kCGEventKeyUp = 11;
const kCGScrollEventUnitPixel = 0;
const kCGScrollEventUnitLine = 1;
// CGEventField
const kCGMouseEventClickState = 1;
const kCGKeyboardEventKeycode = 9;
// CGEventFlags
const kCGEventFlagMaskShift = 0x00020000;
const kCGEventFlagMaskControl = 0x00040000;
const kCGEventFlagMaskAlternate = 0x00080000;
const kCGEventFlagMaskCommand = 0x00100000;

/** 键名 → macOS keycode（常用子集；完整表按需扩充）。 */
const KEYCODES = Object.freeze({
  a: 0x00, s: 0x01, d: 0x02, f: 0x03, h: 0x04, g: 0x05, z: 0x06, x: 0x07,
  c: 0x08, v: 0x09, b: 0x0b, q: 0x0c, w: 0x0d, e: 0x0e, r: 0x0f, y: 0x10,
  t: 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17,
  "=": 0x18, "9": 0x19, "7": 0x1a, "-": 0x1b, "8": 0x1c, "0": 0x1d, "]": 0x1e,
  o: 0x1f, u: 0x20, "[": 0x21, i: 0x22, p: 0x23, l: 0x25, j: 0x26, "'": 0x27,
  k: 0x28, ";": 0x29, "\\": 0x2a, ",": 0x2b, "/": 0x2c, n: 0x2d, m: 0x2e,
  ".": 0x2f, space: 0x31, return: 0x24, enter: 0x24, tab: 0x30, escape: 0x35,
  delete: 0x33, backspace: 0x33, forwarddelete: 0x75, home: 0x73, end: 0x77,
  pageup: 0x74, pagedown: 0x79, leftarrow: 0x7b, rightarrow: 0x7c,
  downarrow: 0x7d, uparrow: 0x7e, f1: 0x7a, f2: 0x78, f3: 0x63, f4: 0x76,
  f5: 0x60, f6: 0x61, f7: 0x62, f8: 0x64, f9: 0x65, f10: 0x6d, f11: 0x67,
  f12: 0x6f, capslock: 0x39,
});

const MODIFIER_FLAGS = Object.freeze({
  shift: kCGEventFlagMaskShift,
  control: kCGEventFlagMaskControl,
  ctrl: kCGEventFlagMaskControl,
  alt: kCGEventFlagMaskAlternate,
  option: kCGEventFlagMaskAlternate,
  cmd: kCGEventFlagMaskCommand,
  command: kCGEventFlagMaskCommand,
  meta: kCGEventFlagMaskCommand,
});

/** "cmd+shift+t" → { keycodes, flags }；未知键返回 undefined。 */
export function parseKeyChord(chord) {
  const parts = String(chord ?? "")
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  let flags = 0;
  const keycodes = [];
  for (const part of parts) {
    const modifier = MODIFIER_FLAGS[part];
    if (modifier !== undefined) {
      flags |= modifier;
      continue;
    }
    const keycode = KEYCODES[part];
    if (keycode === undefined) return undefined;
    keycodes.push(keycode);
  }
  if (keycodes.length !== 1) return undefined;
  return { keycode: keycodes[0], flags };
}

/** 鼠标按钮名 → CG 按钮 index。 */
function buttonIndex(button) {
  if (button === "right") return 1;
  if (button === "middle") return 2;
  return 0; // left
}

function mouseEventTypeFor(button, down) {
  if (button === "right") return down ? kCGEventRightMouseDown : kCGEventRightMouseUp;
  if (button === "middle") return down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp;
  return down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
}

/**
 * click（strategy=event）：CGEvent 合成。坐标为全局屏幕点。
 * 返回 { ok:true } 或 { ok:false, error:{code,message} }。
 */
export function clickAtPoint({ x, y, button = "left", clickCount = 1 }) {
  const bindings = loadKoffiBindings();
  if (!bindings) {
    return { ok: false, error: { code: "cua_koffi_error", message: "koffi bindings unavailable" } };
  }
  const numericX = Number(x);
  const numericY = Number(y);
  if (!Number.isFinite(numericX) || !Number.isFinite(numericY)) {
    return { ok: false, error: { code: "invalid_params", message: "x/y must be finite numbers" } };
  }
  const index = buttonIndex(button);
  const eventType = mouseEventTypeFor(button, true);
  let source;
  try {
    source = bindings.CGEventSourceCreate(kCGEventSourceHIDSystemState);
  } catch (error) {
    return { ok: false, error: { code: "cua_koffi_error", message: `CGEventSourceCreate failed: ${String(error)}` } };
  }
  try {
    postWithCount(bindings, source, kCGEventMouseMoved, numericX, numericY, index, 1);
    const downType = mouseEventTypeFor(button, true);
    const upType = mouseEventTypeFor(button, false);
    const totalClicks = Math.max(1, Math.min(Number(clickCount) || 1, 3));
    for (let count = 1; count <= totalClicks; count += 1) {
      postWithCount(bindings, source, downType, numericX, numericY, index, count);
      postWithCount(bindings, source, upType, numericX, numericY, index, count);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: { code: "cua_koffi_error", message: String(error) } };
  } finally {
    try {
      bindings.CFRelease(source);
    } catch {
      // 释放失败不折断结果。
    }
  }
}

function postWithCount(bindings, source, type, x, y, index, count) {
  const event = bindings.CGEventCreateMouseEvent(source, type, x, y, index);
  if (!event) throw new Error("CGEventCreateMouseEvent returned null");
  try {
    bindings.CGEventSetIntegerValueField(event, kCGMouseEventClickState, count);
    bindings.CGEventPost(kCGHIDEventTap, event);
  } finally {
    bindings.CFRelease(event);
  }
}

/** scroll：CGEventCreateScrollWheelEvent2（axis 0=竖 1=横）。 */
export function scrollAtPoint({ x, y, deltaX = 0, deltaY = 0, unit = "line" }) {
  const bindings = loadKoffiBindings();
  if (!bindings) {
    return { ok: false, error: { code: "cua_koffi_error", message: "koffi bindings unavailable" } };
  }
  const numericX = Number(x);
  const numericY = Number(y);
  if (!Number.isFinite(numericX) || !Number.isFinite(numericY)) {
    return { ok: false, error: { code: "invalid_params", message: "x/y must be finite numbers" } };
  }
  const scrollUnit = unit === "pixel" ? kCGScrollEventUnitPixel : kCGScrollEventUnitLine;
  let source;
  try {
    source = bindings.CGEventSourceCreate(kCGEventSourceHIDSystemState);
  } catch (error) {
    return { ok: false, error: { code: "cua_koffi_error", message: `CGEventSourceCreate failed: ${String(error)}` } };
  }
  try {
    const event = bindings.CGEventCreateScrollWheelEvent2(
      source,
      0, // flags
      2, // wheelCount（横+竖）
      scrollUnit,
      -Number(deltaY) || 0, // CG 正值=内容上滚（自然方向与 Windows addon 相反，此处取负对齐"向下滚动"语义）
      Number(deltaX) || 0,
    );
    if (!event) throw new Error("CGEventCreateScrollWheelEvent2 returned null");
    try {
      bindings.CGEventPost(kCGSessionEventTap, event);
    } finally {
      bindings.CFRelease(event);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: { code: "cua_koffi_error", message: String(error) } };
  } finally {
    try {
      bindings.CFRelease(source);
    } catch {
      // 同上。
    }
  }
}

/** press_key：keychord 合成（down+up 成对）。 */
export function pressKey({ key }) {
  const bindings = loadKoffiBindings();
  if (!bindings) {
    return { ok: false, error: { code: "cua_koffi_error", message: "koffi bindings unavailable" } };
  }
  const parsed = parseKeyChord(key);
  if (!parsed) {
    return {
      ok: false,
      error: { code: "invalid_params", message: `unknown key or modifier in "${key}"` },
    };
  }
  let source;
  try {
    source = bindings.CGEventSourceCreate(kCGEventSourceHIDSystemState);
  } catch (error) {
    return { ok: false, error: { code: "cua_koffi_error", message: `CGEventSourceCreate failed: ${String(error)}` } };
  }
  try {
    for (const down of [true, false]) {
      const event = bindings.CGEventCreateKeyboardEvent(source, parsed.keycode, down);
      if (!event) throw new Error("CGEventCreateKeyboardEvent returned null");
      try {
        if (parsed.flags !== 0) bindings.CGEventSetFlags(event, parsed.flags);
        bindings.CGEventPost(kCGHIDEventTap, event);
      } finally {
        bindings.CFRelease(event);
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: { code: "cua_koffi_error", message: String(error) } };
  } finally {
    try {
      bindings.CFRelease(source);
    } catch {
      // 同上。
    }
  }
}

/**
 * typeText：按字符合成 keydown/keyup。
 * ⚠ 中文/非 ASCII 字符 CGEvent keycode 路径不可达——这类输入必须走
 * type_text_to_app（AX set_value）或 paste 路径；本函数收到非 ASCII 即拒绝。
 */
export function typeAsciiText({ text, delayMs = 0 }) {
  const bindings = loadKoffiBindings();
  if (!bindings) {
    return { ok: false, error: { code: "cua_koffi_error", message: "koffi bindings unavailable" } };
  }
  const value = String(text ?? "");
  if (/[^\x20-\x7E\r\n\t]/u.test(value)) {
    return {
      ok: false,
      error: {
        code: "non_ascii_unsupported",
        message: "CGEvent keycode path is ASCII-only; use type_text_to_app (AX set_value) or paste for CJK/emoji input",
      },
    };
  }
  let source;
  try {
    source = bindings.CGEventSourceCreate(kCGEventSourceHIDSystemState);
  } catch (error) {
    return { ok: false, error: { code: "cua_koffi_error", message: `CGEventSourceCreate failed: ${String(error)}` } };
  }
  try {
    for (const char of value) {
      // 可打印 ASCII 的字符级映射：空格/制表/回车先归一到键名（2026-10-05 实测：
      // 空格漏映射导致 " TYPED-OK" 首字符即拒）。
      const charKey =
        char === " " ? "space" : char === "\t" ? "tab" : char === "\r" || char === "\n" ? "return" : null;
      const chars = charKey ?? char;
      const lower = chars.toLowerCase();
      const needsShift = !charKey && chars !== lower && chars.toUpperCase() === chars && /[A-Z]/u.test(chars);
      const keycode = KEYCODES[lower];
      if (keycode === undefined) {
        return {
          ok: false,
          error: { code: "non_ascii_unsupported", message: `no keycode for character ${JSON.stringify(char)}` },
        };
      }
      for (const down of [true, false]) {
        const event = bindings.CGEventCreateKeyboardEvent(source, keycode, down);
        if (!event) throw new Error("CGEventCreateKeyboardEvent returned null");
        try {
          if (needsShift && down) bindings.CGEventSetFlags(event, kCGEventFlagMaskShift);
          bindings.CGEventPost(kCGHIDEventTap, event);
        } finally {
          bindings.CFRelease(event);
        }
      }
      if (delayMs > 0) {
        // 同步接口内小延迟：Atomics.wait 阻塞当前线程（合成输入通常 <100ms 总时长）。
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(delayMs, 50));
      }
    }
    return { ok: true, typed: value.length };
  } catch (error) {
    return { ok: false, error: { code: "cua_koffi_error", message: String(error) } };
  } finally {
    try {
      bindings.CFRelease(source);
    } catch {
      // 同上。
    }
  }
}

/**
 * elementSetValue：AXUIElementSetAttributeValue(AXValue, CFString(value))。
 * 文本输入的正路（CJK 安全、不抢焦点、不经过键盘事件流）。
 */
export function elementSetValue({ pid, elementRef, value }) {
  const bindings = loadKoffiBindings();
  if (!bindings || !elementRef) {
    return { ok: false, error: { code: "cua_koffi_error", message: "koffi bindings or element unavailable" } };
  }
  void pid;
  return withCFString(bindings, "AXValue", (valueName) =>
    withCFString(bindings, String(value ?? ""), (valueRef) => {
      try {
        const err = bindings.AXUIElementSetAttributeValue(elementRef, valueName, valueRef);
        return err === AXError.Success
          ? { ok: true }
          : { ok: false, error: { code: "ax_error", message: describeAxErrorPublic(err) } };
      } catch (error) {
        return { ok: false, error: { code: "cua_koffi_error", message: String(error) } };
      }
    }),
  );
}

/**
 * elementPerformAction：AXUIElementPerformAction（AXPress/AXConfirm 等）。
 * a11y 策略 click 的正路。
 */
export function elementPerformAction({ elementRef, action = "AXPress" }) {
  const bindings = loadKoffiBindings();
  if (!bindings || !elementRef) {
    return { ok: false, error: { code: "cua_koffi_error", message: "koffi bindings or element unavailable" } };
  }
  return withCFString(bindings, String(action ?? "AXPress"), (actionName) => {
    try {
      const err = bindings.AXUIElementPerformAction(elementRef, actionName);
      return err === AXError.Success
        ? { ok: true }
        : { ok: false, error: { code: "ax_error", message: describeAxErrorPublic(err) } };
    } catch (error) {
      return { ok: false, error: { code: "cua_koffi_error", message: String(error) } };
    }
  });
}

/** 元素级读取辅助：动作面校验 element 支持哪些 action（AXActions 属性清单）。 */
export function elementActionNames(elementRef) {
  const bindings = loadKoffiBindings();
  if (!bindings || !elementRef) return [];
  const out = [null];
  try {
    const err = bindings.AXUIElementCopyActionNames(elementRef, out);
    if (err !== AXError.Success) return [];
    const names = [];
    for (const ref of cfArrayToRefs(bindings, out[0])) {
      const name = cfStringToJs(bindings, ref);
      if (name) names.push(name);
    }
    return names;
  } catch {
    return [];
  }
}

function describeAxErrorPublic(error) {
  return describeAxError(error);
}
