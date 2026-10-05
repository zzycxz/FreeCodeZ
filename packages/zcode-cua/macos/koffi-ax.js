// ============================================================
// Phase 1-a：koffi FFI 绑定——macOS AX/CG C API（升级实施手册 桌面控制 Phase 1）
// ============================================================
// 纪律（手册三道保险之三）：
//   - koffi/framework 加载惰性：模块 import 零副作用，非 darwin 或 koffi 缺失时
//     loadKoffiBindings() 返回 null（上层 fail-closed 回 unavailable stub）；
//   - 每个 CF 分配必须配对 CFRelease——消费侧用 withCFString/withReleased 包 try-finally；
//   - 所有 C 调用可能抛（koffi 类型错误）或返回 AXError——都折成结构化错误，不 crash 主进程。
// 绑定依据：HIServices.framework（AX 族）+ CoreFoundation（CFString/CFArray）+
// CoreGraphics（CGEvent/CGWindow 族），路径 macOS 固定。
// 实证（2026-10-05，本机）：AXUIElementCreateApplication(pid) + CopyAttributeValue
// 在宿主 TCC 已授时 err=0；systemWide 路径 -25204（APIDisabled）——观测面统一走 pid。

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const HISERVICES_PATH =
  "/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices";
const COREFOUNDATION_PATH =
  "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const COREGRAPHICS_PATH =
  "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";

/** AXError 常量（HIServices AXError.h）。 */
export const AXError = Object.freeze({
  Success: 0,
  Failure: -25200,
  InvalidUIElement: -25202,
  CannotComplete: -25204,
  AttributeUnsupported: -25205,
  ActionUnsupported: -25206,
  NotificationUnsupported: -25208,
  NotTrusted: -25211,
  NoValue: -25212,
  ParameterizedAttributeUnsupported: -25213,
  NotEnoughPrecision: -25214,
});

/** AXError → 人读结论（结构化错误的 reason 面）。 */
export function describeAxError(error) {
  for (const [name, code] of Object.entries(AXError)) {
    if (code === error) return `kAXError${name}(${error})`;
  }
  return `AXError(${error})`;
}

export const kCFStringEncodingUTF8 = 0x08000100;

let cachedBindings = undefined;

/**
 * 加载并缓存全部 C 绑定。koffi 缺失 / 非 darwin / framework 加载失败 → undefined
 * （上层回 fail-closed stub，绝不 throw）。二次调用走缓存。
 */
export function loadKoffiBindings() {
  if (cachedBindings !== undefined) return cachedBindings;
  try {
    if (process.platform !== "darwin") {
      cachedBindings = null;
      return cachedBindings;
    }
    const koffi = require("koffi");
    const HIServices = koffi.load(HISERVICES_PATH);
    const CF = koffi.load(COREFOUNDATION_PATH);
    const CG = koffi.load(COREGRAPHICS_PATH);

    // ── CoreFoundation：字符串与数组 ──
    const CFStringCreateWithCString = CF.func(
      "CFStringCreateWithCString",
      "void*",
      ["void*", "string", "uint32"],
    );
    const CFRelease = CF.func("CFRelease", "void", ["void*"]);
    // Get/Create 惯例修正：CFArrayGetValueAtIndex 等返回的 ref 归数组所有；
    // 需要延长生命周期（元素句柄表）时显式 CFRetain +1。
    const CFRetain = CF.func("CFRetain", "void*", ["void*"]);
    const CFStringGetCString = CF.func("CFStringGetCString", "bool", [
      "void*",
      "void*",
      "long",
      "uint32",
    ]);
    const CFStringGetLength = CF.func("CFStringGetLength", "uint64", ["void*"]);
    const CFGetTypeID = CF.func("CFGetTypeID", "uint64", ["void*"]);
    const CFStringGetTypeID = CF.func("CFStringGetTypeID", "uint64", []);
    const CFArrayGetTypeID = CF.func("CFArrayGetTypeID", "uint64", []);
    const CFArrayGetCount = CF.func("CFArrayGetCount", "uint64", ["void*"]);
    const CFArrayGetValueAtIndex = CF.func("CFArrayGetValueAtIndex", "void*", [
      "void*",
      "uint64",
    ]);
    const CFNumberGetTypeID = CF.func("CFNumberGetTypeID", "uint64", []);
    const CFNumberGetValue = CF.func("CFNumberGetValue", "bool", [
      "void*",
      "uint32",
      "void*",
    ]);
    const CFBooleanGetValue = CF.func("CFBooleanGetValue", "bool", ["void*"]);
    const CFBooleanGetTypeID = CF.func("CFBooleanGetTypeID", "uint64", []);
    const kCFNumberFloat64Type = 6; // CFNumberType.h

    // ── HIServices：AX 观测与动作 ──
    const AXIsProcessTrusted = HIServices.func("AXIsProcessTrusted", "bool", []);
    const AXUIElementCreateApplication = HIServices.func(
      "AXUIElementCreateApplication",
      "void*",
      ["int32"],
    );
    const AXUIElementCreateSystemWide = HIServices.func(
      "AXUIElementCreateSystemWide",
      "void*",
      [],
    );
    // out 参数必须 koffi.out 标注，否则 C 侧写回不进 JS（2026-10-05 实测：不标注时
    // AXUIElementCopyAttributeValue 返回 0 但 out 恒 null——假成功）。
    const AXUIElementCopyAttributeValue = HIServices.func(
      "AXUIElementCopyAttributeValue",
      "int32",
      ["void*", "void*", koffi.out("void**")],
    );
    const AXUIElementCopyAttributeNames = HIServices.func(
      "AXUIElementCopyAttributeNames",
      "int32",
      ["void*", koffi.out("void**")],
    );
    const AXUIElementCopyActionNames = HIServices.func(
      "AXUIElementCopyActionNames",
      "int32",
      ["void*", koffi.out("void**")],
    );
    const AXUIElementSetAttributeValue = HIServices.func(
      "AXUIElementSetAttributeValue",
      "int32",
      ["void*", "void*", "void*"],
    );
    const AXUIElementPerformAction = HIServices.func(
      "AXUIElementPerformAction",
      "int32",
      ["void*", "void*"],
    );
    const AXUIElementGetPid = HIServices.func("AXUIElementGetPid", "int32", [
      "void*",
      koffi.out("int32*"),
    ]);
    // AXValue struct（CGPoint/CGSize）官方解码——koffi 读原始内存不可靠，走 HIServices API。
    const AXValueGetValue = HIServices.func("AXValueGetValue", "bool", [
      "void*",
      "uint32",
      koffi.out("void*"),
    ]);

    // ── CoreGraphics：事件合成与截屏预检 ──
    const CGEventCreateMouseEvent = CG.func(
      "CGEventCreateMouseEvent",
      "void*",
      ["void*", "int32", "double", "double", "int32"],
    );
    const CGEventCreateKeyboardEvent = CG.func(
      "CGEventCreateKeyboardEvent",
      "void*",
      ["void*", "int32", "bool"],
    );
    const CGEventCreateScrollWheelEvent2 = CG.func(
      "CGEventCreateScrollWheelEvent2",
      "void*",
      ["void*", "uint32", "uint32", "int32", "int32", "int32"],
    );
    const CGEventPost = CG.func("CGEventPost", "void", ["int32", "void*"]);
    const CGEventSetIntegerValueField = CG.func(
      "CGEventSetIntegerValueField",
      "void",
      ["void*", "uint32", "int64"],
    );
    const CGEventSetFlags = CG.func("CGEventSetFlags", "void", ["void*", "uint64"]);
    // CGEventRef 亦为 CFType——复用上方 CFRelease 释放。
    const CGPreflightScreenCaptureAccess = CG.func(
      "CGPreflightScreenCaptureAccess",
      "bool",
      [],
    );
    const CGRequestScreenCaptureAccess = CG.func(
      "CGRequestScreenCaptureAccess",
      "bool",
      [],
    );
    const CGGetLastMouseDelta = CG.func("CGGetLastMouseDelta", "void", [
      "void*",
      "void*",
    ]);
    const CGEventSourceCreate = CG.func("CGEventSourceCreate", "void*", ["uint32"]);

    // kCGHIDEventTap=0, kCGSessionEventTap=1; 鼠标类型见 CGEventType。
    const bindings = {
      koffi,
      CFStringCreateWithCString,
      CFRelease,
      CFRetain,
      CFStringGetCString,
      CFStringGetLength,
      CFGetTypeID,
      CFStringGetTypeID,
      CFArrayGetTypeID,
      CFArrayGetCount,
      CFArrayGetValueAtIndex,
      CFNumberGetTypeID,
      CFNumberGetValue,
      CFBooleanGetTypeID,
      CFBooleanGetValue,
      kCFNumberFloat64Type,
      AXIsProcessTrusted,
      AXUIElementCreateApplication,
      AXUIElementCreateSystemWide,
      AXUIElementCopyAttributeValue,
      AXUIElementCopyAttributeNames,
      AXUIElementCopyActionNames,
      AXUIElementSetAttributeValue,
      AXUIElementPerformAction,
      AXUIElementGetPid,
      AXValueGetValue,
      CGEventCreateMouseEvent,
      CGEventCreateKeyboardEvent,
      CGEventCreateScrollWheelEvent2,
      CGEventPost,
      CGEventSetIntegerValueField,
      CGEventSetFlags,
      CGPreflightScreenCaptureAccess,
      CGRequestScreenCaptureAccess,
      CGEventSourceCreate,
    };
    cachedBindings = Object.freeze(bindings);
    return cachedBindings;
  } catch {
    // koffi 缺失（本地 dev 未装依赖）或 framework 路径变化：fail-closed。
    cachedBindings = null;
    return cachedBindings;
  }
}

/** 读 CFString → JS string；非字符串 CFType 或读取失败 → undefined。 */
export function cfStringToJs(bindings, ref) {
  if (!ref) return undefined;
  try {
    if (bindings.CFGetTypeID(ref) !== bindings.CFStringGetTypeID()) return undefined;
    const length = Number(bindings.CFStringGetLength(ref));
    if (length === 0) return "";
    const size = length * 4 + 1;
    const buffer = Buffer.alloc(size);
    const ok = bindings.CFStringGetCString(ref, buffer, size, kCFStringEncodingUTF8);
    if (!ok) return undefined;
    // CFStringGetCString 以 NUL 截断。
    const end = buffer.indexOf(0);
    return buffer.toString("utf8", 0, end === -1 ? size : end);
  } catch {
    return undefined;
  }
}

/** 读 CFNumber（float64）→ JS number；非数值 → undefined。 */
export function cfNumberToJs(bindings, ref) {
  if (!ref) return undefined;
  try {
    if (bindings.CFGetTypeID(ref) !== bindings.CFNumberGetTypeID()) return undefined;
    const out = new ArrayBuffer(8);
    const ok = bindings.CFNumberGetValue(ref, bindings.kCFNumberFloat64Type, out);
    if (!ok) return undefined;
    return Number(new DataView(out).getFloat64(0, true));
  } catch {
    return undefined;
  }
}

/** 读 CFBoolean → JS bool；非布尔 → undefined。 */
export function cfBooleanToJs(bindings, ref) {
  if (!ref) return undefined;
  try {
    if (bindings.CFGetTypeID(ref) !== bindings.CFBooleanGetTypeID()) return undefined;
    return bindings.CFBooleanGetValue(ref);
  } catch {
    return undefined;
  }
}

/** CFArray 浅枚举 → JS array（元素是 CF ref，交给回调处理；数组本体由调用方释放）。 */
export function cfArrayToRefs(bindings, ref) {
  if (!ref) return [];
  try {
    if (bindings.CFGetTypeID(ref) !== bindings.CFArrayGetTypeID()) return [];
    const count = Number(bindings.CFArrayGetCount(ref));
    const refs = [];
    for (let index = 0; index < count; index += 1) {
      const item = bindings.CFArrayGetValueAtIndex(ref, index);
      if (item) refs.push(item);
    }
    return refs;
  } catch {
    return [];
  }
}

/**
 * withCFString：创建临时 CFString 并保证释放（三道保险之三的 try-finally 纪律）。
 * callback 收到 CFStringRef；抛错也走 finally。
 */
export function withCFString(bindings, value, callback) {
  const ref = bindings.CFStringCreateWithCString(null, value, kCFStringEncodingUTF8);
  if (!ref) throw new Error(`koffi: CFStringCreateWithCString failed for "${value}"`);
  try {
    return callback(ref);
  } finally {
    try {
      bindings.CFRelease(ref);
    } catch {
      // 释放失败不吞结果——AXError 已在 callback 结果里。
    }
  }
}

/** withReleased：包裹任何需要 CFRelease 的 ref 的作用域（防御泄漏面）。 */
export function withReleased(bindings, refs, callback) {
  const list = Array.isArray(refs) ? refs : [refs];
  try {
    return callback();
  } finally {
    for (const ref of list) {
      if (!ref) continue;
      try {
        bindings.CFRelease(ref);
      } catch {
        // 同上：释放失败不吞业务结果。
      }
    }
  }
}
