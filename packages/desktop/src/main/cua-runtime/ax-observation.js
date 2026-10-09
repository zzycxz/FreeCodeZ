// FreeCodeZ 原创件（R10①档）自旧执行层复刻包 macos/ 目录平移（W-29，溯源锚 git 7ba4bec^）。
// ============================================================
// Phase 1-b：AX 观测面——list_applications / list_windows / capture_app 树读取
// （升级实施手册 桌面控制 Phase 1；只读阶段优先）
// ============================================================
// 实现策略（对照 Windows addon 的 broker 方法面）：
//   - 进程枚举走 `lsappinfo list`（LaunchServices 官方 CLI，零权限要求），
//     解析 bundleID/pid/name；AX 树读取全走 koffi（koffi-ax.js 绑定）。
//   - bounds 走官方 AXValueGetValue（koffi 读原始内存不可靠——2026-10-05 实测）。
//   - 每个导出函数 fail-soft：AXError 折成结构化结果，绝不 throw 进 broker。

import { execFile } from "node:child_process";
import {
  loadKoffiBindings,
  withCFString,
  cfStringToJs,
  cfArrayToRefs,
  cfBooleanToJs,
  describeAxError,
  AXError,
} from "./koffi-ax.js";

const LSAPPINFO_TIMEOUT_MS = 4_000;
const LSAPPINFO_PATH = "/usr/bin/lsappinfo";
/** AX 树递归深度上限：防失控树打爆内存（Windows addon 同款防御）。 */
export const MAX_TREE_DEPTH = 12;
/** 单次 capture 的元素总数上限。 */
export const MAX_TREE_NODES = 600;

function execFileText(file, args, timeoutMs = LSAPPINFO_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * 解析 `lsappinfo list` 输出：块形如
 *   12) "Finder" ASN:0x0-0x...:
 *       bundleID="com.apple.finder"
 *       pid = 512 type="Foreground" flavor=...
 * 只收有 bundleID 且 type 为 Foreground/UIElement 的 GUI 应用。
 */
export function parseLsappinfoList(stdout) {
  const apps = [];
  const blockPattern = /^\s*\d+\)\s+"([^"]*)"\s+ASN:/u;
  let current = undefined;
  for (const rawLine of stdout.split("\n")) {
    const header = blockPattern.exec(rawLine);
    if (header) {
      if (current && current.pid !== undefined && current.bundleId) apps.push(current);
      current = { name: header[1] ?? "" };
      continue;
    }
    if (!current) continue;
    const bundle = /bundleID="([^"]*)"/u.exec(rawLine);
    if (bundle) {
      current.bundleId = bundle[1];
      continue;
    }
    const pidMatch = /\bpid = (\d+)/u.exec(rawLine);
    if (pidMatch) {
      current.pid = Number(pidMatch[1]);
      continue;
    }
    const typeMatch = /type="([^"]*)"/u.exec(rawLine);
    if (typeMatch) current.type = typeMatch[1];
  }
  if (current && current.pid !== undefined && current.bundleId) apps.push(current);
  return apps.filter(
    (app) => app.type === "Foreground" || app.type === "UIElement" || app.type === undefined,
  );
}

/** 读 AXValue struct（kAXValueCGPointType=1 / kAXValueCGSizeType=2）。 */
function readAxValueStruct(bindings, ref, kind) {
  if (!ref) return undefined;
  const out = new ArrayBuffer(16);
  let ok;
  try {
    ok = bindings.AXValueGetValue(ref, kind, out);
  } catch {
    return undefined;
  }
  if (!ok) return undefined;
  // CGFloat 在 arm64 上是 double（CGPoint/CGSize = 2×f64=16B）——Float32 解析会出
  // 碎片值（2026-10-05 实测 h=4.9375）。
  const values = new Float64Array(out);
  return kind === 1 ? { x: values[0], y: values[1] } : { width: values[0], height: values[1] };
}

/** 读应用/元素的字符串属性。 */
function copyStringAttribute(bindings, element, attributeName) {
  return withCFString(bindings, attributeName, (name) => {
    const out = [null];
    const err = bindings.AXUIElementCopyAttributeValue(element, name, out);
    if (err !== AXError.Success) return undefined;
    return cfStringToJs(bindings, out[0]);
  });
}

/** 读 AXValue 属性（Position/Size）。 */
function copyStructAttribute(bindings, element, attributeName, kind) {
  return withCFString(bindings, attributeName, (name) => {
    const out = [null];
    const err = bindings.AXUIElementCopyAttributeValue(element, name, out);
    if (err !== AXError.Success) return undefined;
    return readAxValueStruct(bindings, out[0], kind);
  });
}

/** 读布尔属性（Main/Minimized/Focused）。 */
function copyBooleanAttribute(bindings, element, attributeName) {
  return withCFString(bindings, attributeName, (name) => {
    const out = [null];
    const err = bindings.AXUIElementCopyAttributeValue(element, name, out);
    if (err !== AXError.Success) return undefined;
    return cfBooleanToJs(bindings, out[0]);
  });
}

/** 读 CFArray 属性的 ref 列表（调用方负责对每个 ref 后续读取与释放）。 */
function copyArrayAttribute(bindings, element, attributeName) {
  return withCFString(bindings, attributeName, (name) => {
    const out = [null];
    const err = bindings.AXUIElementCopyAttributeValue(element, name, out);
    if (err !== AXError.Success) return undefined;
    return cfArrayToRefs(bindings, out[0]);
  });
}

/**
 * list_applications：前台 GUI 应用清单。
 * 观测语义与 Windows addon 对齐：返回 pid/name/bundleId + 可见窗口计数。
 */
export async function listApplications() {
  const bindings = loadKoffiBindings();
  if (!bindings) {
    return { ok: false, error: { code: "cua_koffi_error", message: "koffi bindings unavailable" } };
  }
  let stdout;
  try {
    stdout = await execFileText(LSAPPINFO_PATH, ["list"]);
  } catch (error) {
    return {
      ok: false,
      error: { code: "cua_koffi_error", message: `lsappinfo failed: ${String(error)}` },
    };
  }
  const candidates = parseLsappinfoList(stdout);
  const applications = [];
  for (const candidate of candidates) {
    if (!Number.isInteger(candidate.pid) || candidate.pid <= 1) continue;
    const info = readApplicationWindowSummary(bindings, candidate.pid);
    // AX 树不可读（未运行/沙箱内应用/被隐藏）仍列出——broker 语义是"应用清单"不是"可操作清单"。
    applications.push({
      pid: candidate.pid,
      name: info?.name || candidate.name,
      bundleId: candidate.bundleId,
      windowCount: info?.windowCount ?? 0,
    });
  }
  return { ok: true, applications };
}

/** 按 pid 读应用名与窗口计数（AX 不可读时返回 undefined）。 */
function readApplicationWindowSummary(bindings, pid) {
  let appEl;
  try {
    appEl = bindings.AXUIElementCreateApplication(pid);
  } catch {
    return undefined;
  }
  if (!appEl) return undefined;
  try {
    const title = copyStringAttribute(bindings, appEl, "AXTitle");
    const windows = copyArrayAttribute(bindings, appEl, "AXWindows");
    return {
      name: title,
      windowCount: windows ? windows.length : 0,
    };
  } finally {
    try {
      bindings.CFRelease(appEl);
    } catch {
      // 释放失败不折断读取结果。
    }
  }
}

/** 窗口 bounds 读取（Position+Size 成对；任一缺席则整个 bounds 缺席）。 */
function readWindowBounds(bindings, window) {
  const position = copyStructAttribute(bindings, window, "AXPosition", 1);
  const size = copyStructAttribute(bindings, window, "AXSize", 2);
  if (!position || !size) return undefined;
  return { x: position.x, y: position.y, width: size.width, height: size.height };
}

/**
 * list_windows：目标应用的窗口清单（role/title/bounds/main/minimized）。
 */
export async function listWindows(pid) {
  const bindings = loadKoffiBindings();
  if (!bindings) {
    return { ok: false, error: { code: "cua_koffi_error", message: "koffi bindings unavailable" } };
  }
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return { ok: false, error: { code: "invalid_params", message: "pid must be a positive integer" } };
  }
  let appEl;
  try {
    appEl = bindings.AXUIElementCreateApplication(numericPid);
  } catch (error) {
    return { ok: false, error: { code: "cua_koffi_error", message: String(error) } };
  }
  if (!appEl) {
    return { ok: false, error: { code: "cua_koffi_error", message: `AXUIElementCreateApplication(${numericPid}) returned null` } };
  }
  try {
    const windows = copyArrayAttribute(bindings, appEl, "AXWindows");
    if (windows === undefined) {
      // AXError 语义在 app 级 AXWindows 上常见 NoValue（无窗口）与 CannotComplete（TCC 缺），
      // 无从分辨时返回空清单 + 提示（不谎报失败——空窗口是合法状态）。
      return {
        ok: true,
        windows: [],
        note: "AXWindows attribute unavailable (no windows, or accessibility not granted to this process)",
      };
    }
    const result = [];
    for (const window of windows) {
      if (!window) continue;
      const role = copyStringAttribute(bindings, window, "AXRole") ?? "AXWindow";
      const title = copyStringAttribute(bindings, window, "AXTitle") ?? "";
      const bounds = readWindowBounds(bindings, window);
      const main = copyBooleanAttribute(bindings, window, "AXMain") ?? false;
      const minimized = copyBooleanAttribute(bindings, window, "AXMinimized") ?? false;
      // Get 惯例：window ref 来自 CFArrayGetValueAtIndex，归数组所有——不释放。
      result.push({
        role,
        title,
        ...(bounds ? { bounds } : {}),
        main,
        minimized,
      });
    }
    return { ok: true, windows: result };
  } finally {
    try {
      bindings.CFRelease(appEl);
    } catch {
      // 同上。
    }
  }
}

/** AX 树节点（capture_app 的 elements[] 项）。 */
function readTreeNode(bindings, element, depth, budget) {
  if (depth > MAX_TREE_DEPTH || budget.used >= MAX_TREE_NODES) return undefined;
  const role = copyStringAttribute(bindings, element, "AXRole");
  if (!role) return undefined;
  budget.used += 1;
  const title = copyStringAttribute(bindings, element, "AXTitle");
  const value = copyStringAttribute(bindings, element, "AXValue");
  const roleDescription = copyStringAttribute(bindings, element, "AXRoleDescription");
  const position = copyStructAttribute(bindings, element, "AXPosition", 1);
  const size = copyStructAttribute(bindings, element, "AXSize", 2);
  const focused = copyBooleanAttribute(bindings, element, "AXFocused") ?? false;
  // 多表面捕获（P1-f）：AXSheet/AXPopover/AXDrawer 是 attached 表面。
  const surfaceKind =
    role === "AXSheet"
      ? "attached_dialog"
      : role === "AXPopover" || role === "AXDrawer"
        ? "popover"
        : depth === 0 && role === "AXWindow"
          ? "window"
          : undefined;
  const node = {
    role,
    ...(title ? { title } : {}),
    ...(value !== undefined && value !== "" ? { value } : {}),
    ...(roleDescription ? { roleDescription } : {}),
    ...(position && size
      ? {
          bounds: {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
          },
        }
      : {}),
    focused,
    ...(surfaceKind ? { surfaceKind } : {}),
  };
  const children = copyArrayAttribute(bindings, element, "AXChildren");
  if (children && children.length > 0 && budget.used < MAX_TREE_NODES) {
    const childNodes = [];
    for (const child of children) {
      if (!child) continue;
      const childNode = readTreeNode(bindings, child, depth + 1, budget);
      // Get 惯例：不释放数组内元素 ref。
      if (childNode) childNodes.push(childNode);
      if (budget.used >= MAX_TREE_NODES) break;
    }
    if (childNodes.length > 0) node.children = childNodes;
  }
  return node;
}

/**
 * capture_app 的 AX 树读取部分：应用 AX 根 → elements 树（带 bounds/surfaceKind）。
 * 截图部分（image_ref）由调用方按屏幕录制权限分支处理（CGPreflight=false 时缺席）。
 */
export async function readApplicationTree(pid) {
  const bindings = loadKoffiBindings();
  if (!bindings) {
    return { ok: false, error: { code: "cua_koffi_error", message: "koffi bindings unavailable" } };
  }
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return { ok: false, error: { code: "invalid_params", message: "pid must be a positive integer" } };
  }
  let appEl;
  try {
    appEl = bindings.AXUIElementCreateApplication(numericPid);
  } catch (error) {
    return { ok: false, error: { code: "cua_koffi_error", message: String(error) } };
  }
  if (!appEl) {
    return {
      ok: false,
      error: { code: "cua_koffi_error", message: `AXUIElementCreateApplication(${numericPid}) returned null` },
    };
  }
  try {
    const appName = copyStringAttribute(bindings, appEl, "AXTitle");
    const budget = { used: 0 };
    const root = readTreeNode(bindings, appEl, 0, budget);
    if (!root) {
      return {
        ok: true,
        appName: appName ?? "",
        elements: [],
        note: `AX tree unreadable (${describeAxError(AXError.CannotComplete)}) — accessibility permission or app AX support required`,
      };
    }
    return { ok: true, appName: appName ?? "", elements: [root], nodeCount: budget.used };
  } finally {
    try {
      bindings.CFRelease(appEl);
    } catch {
      // 同上。
    }
  }
}

/** 权限探针：AXIsProcessTrusted + CGPreflightScreenCaptureAccess。 */
export function probePermissions() {
  const bindings = loadKoffiBindings();
  if (!bindings) {
    return { accessibility: false, screenCapture: false, koffiAvailable: false };
  }
  let accessibility;
  let screenCapture;
  try {
    accessibility = bindings.AXIsProcessTrusted();
  } catch {
    accessibility = false;
  }
  try {
    screenCapture = bindings.CGPreflightScreenCaptureAccess();
  } catch {
    screenCapture = false;
  }
  return { accessibility, screenCapture, koffiAvailable: true };
}

/**
 * 主动发起屏幕录制授权请求（CGRequestScreenCaptureAccess）。
 * FreeCodeZ fork（R21，2026-10-08 用户裁决）：主应用必须在系统「屏幕录制」列表里有自己的
 * 条目——Appshot 截屏主体是主应用，不自注册就永远无处授权。只在用户主动触发点调用；
 * 权限状态已定时系统不再弹窗。失败不抛，调用方按返回值记日志、照常继续。
 * loadBindings 仅测试注入用；缺省与 probePermissions 同源。
 */
export function requestScreenCaptureAccess(loadBindings = loadKoffiBindings) {
  const bindings = loadBindings();
  if (!bindings) {
    return { granted: false, koffiAvailable: false };
  }
  try {
    return { granted: Boolean(bindings.CGRequestScreenCaptureAccess()), koffiAvailable: true };
  } catch {
    return { granted: false, koffiAvailable: true };
  }
}

/**
 * 主动发起辅助功能（AX）授权注册：做一次真实 AX 读（system-wide 属性名表）。未信任时 macOS
 * 按「首次 AX 使用」语义自动弹「想要控制这台电脑」并建 TCC 条目；已信任/已拒绝均零弹窗 no-op。
 * 返回 granted=调用后 AXIsProcessTrusted。失败不抛，返回值供记日志。
 * R21c（2026-10-09 崩溃报告 FreeCodeZ-2026-10-09-105124.ips）：曾用
 * AXIsProcessTrustedWithOptions{prompt:true}＋CFDictionary 构造——字典经 koffi 在 Electron
 * 主进程成为无效指针（AXIsProcessTrustedWithOptions→CFGetTypeID SIGSEGV，启动即崩；裸 node
 * 同代码正常，属 Electron 上下文特异）。整条崩溃面移除：这里只用生产久经考验的 AX 读绑定。
 * loadBindings 仅测试注入用；缺省与 probePermissions 同源。
 */
export function requestAccessibilityAccess(loadBindings = loadKoffiBindings) {
  const bindings = loadBindings();
  if (!bindings) {
    return { granted: false, koffiAvailable: false };
  }
  let element;
  let names;
  try {
    element = bindings.AXUIElementCreateSystemWide();
    const out = [null];
    // 真实 AX 读（out=[null] 惯用法，与观测面同款）：未信任即触发系统注册/弹窗；
    // 错误码无关紧要——注册目的在调用当刻已达。
    bindings.AXUIElementCopyAttributeNames(element, out);
    names = out[0];
    return { granted: Boolean(bindings.AXIsProcessTrusted()), koffiAvailable: true };
  } catch {
    return { granted: false, koffiAvailable: true };
  } finally {
    try {
      if (names) bindings.CFRelease(names);
    } catch {
      // 释放失败不影响结果（短命对象，泄漏面可忽略）。
    }
    try {
      if (element) bindings.CFRelease(element);
    } catch {
      // 同上。
    }
  }
}
