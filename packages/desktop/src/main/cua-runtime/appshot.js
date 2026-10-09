// FreeCodeZ 原创件（R10①档）自旧执行层复刻包 macos/ 目录平移（W-29，溯源锚 git 7ba4bec^）。
// ============================================================
// Phase 3a：Appshot（升级实施手册 桌面控制 Phase 3）
// ============================================================
// 一键喂屏：前台窗口截图（screencapture -l<CGWindowID>）+ Phase 1 AX 树。
// 前台窗口判定：CGWindowListCopyWindowInfo 前到后序，过滤 layer≠0（壁纸/系统层）、
// 光标服务等微小窗（尺寸下限）、自身 pid（HUD/横幅不可能——它们 layer 极高，双保险）。
// 纯逻辑（pickFrontmostAppWindow）与 koffi 读取（buildOnScreenWindowsReader）分离钉测试。

import { execFile } from "node:child_process";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKoffiBindings, withCFString } from "./koffi-ax.js";
import { readApplicationTree } from "./ax-observation.js";

const kUTF8 = 0x08000100;
const SCREENCAPTURE_PATH = "/usr/sbin/screencapture";
const SCREENCAPTURE_TIMEOUT_MS = 6_000;
/** 前台窗口尺寸下限（pt）：滤掉光标 UI/菜单气泡等系统微窗。 */
export const FRONTMOST_MIN_WINDOW_SIZE = { width: 400, height: 300 };

function execFileText(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolve(stdout);
    });
  });
}

/**
 * 读全部在屏窗口（前到后）。koffi 面：CGWindowListCopyWindowInfo + CFDictionary。
 * 失败（无屏幕录制 TCC 时列表仍可读——窗口列表不需要 TCC；koffi 缺失才失败）→ []。
 */
export function buildOnScreenWindowsReader(bindings) {
  const CG = bindings.koffi.load(
    "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics",
  );
  const CF = bindings.koffi.load(
    "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
  );
  const list = CG.func("CGWindowListCopyWindowInfo", "void*", ["uint32", "uint32"]);
  const CFArrayGetCount = CF.func("CFArrayGetCount", "uint64", ["void*"]);
  const CFArrayGetValueAtIndex = CF.func("CFArrayGetValueAtIndex", "void*", ["void*", "uint64"]);
  const CFDictionaryGetValue = CF.func("CFDictionaryGetValue", "void*", ["void*", "void*"]);
  const CFNumberGetValue = CF.func("CFNumberGetValue", "bool", [
    "void*",
    "uint32",
    bindings.koffi.out("void*"),
  ]);
  const CFGetTypeID = CF.func("CFGetTypeID", "uint64", ["void*"]);
  const CFStringGetTypeID = CF.func("CFStringGetTypeID", "uint64", []);
  const CFStringGetCString = CF.func("CFStringGetCString", "bool", [
    "void*",
    "void*",
    "long",
    "uint32",
  ]);
  const CFStringCreate = CF.func("CFStringCreateWithCString", "void*", [
    "void*",
    "string",
    "uint32",
  ]);
  const kCFNumberSInt32 = 3;

  const keys = {
    number: CFStringCreate(null, "kCGWindowNumber", kUTF8),
    pid: CFStringCreate(null, "kCGWindowOwnerPID", kUTF8),
    layer: CFStringCreate(null, "kCGWindowLayer", kUTF8),
    owner: CFStringCreate(null, "kCGWindowOwnerName", kUTF8),
    bounds: CFStringCreate(null, "kCGWindowBounds", kUTF8),
    x: CFStringCreate(null, "X", kUTF8),
    y: CFStringCreate(null, "Y", kUTF8),
    width: CFStringCreate(null, "Width", kUTF8),
    height: CFStringCreate(null, "Height", kUTF8),
  };

  const readInt = (dict, key) => {
    const value = CFDictionaryGetValue(dict, key);
    if (!value) return undefined;
    const out = new ArrayBuffer(8);
    if (!CFNumberGetValue(value, kCFNumberSInt32, out)) return undefined;
    return new DataView(out).getInt32(0, true);
  };
  const readString = (dict, key) => {
    const value = CFDictionaryGetValue(dict, key);
    if (!value || CFGetTypeID(value) !== Number(CFStringGetTypeID())) return undefined;
    const buffer = Buffer.alloc(512);
    if (!CFStringGetCString(value, buffer, 512, kUTF8)) return undefined;
    const text = buffer.toString("utf8");
    const end = text.indexOf("\0");
    return end === -1 ? text : text.slice(0, end);
  };

  return function read() {
    const array = list(0 /* kCGWindowListOptionOnScreenOnly */, 0 /* kCGNullWindowID */);
    if (!array) return [];
    const result = [];
    const count = Number(CFArrayGetCount(array));
    for (let index = 0; index < count; index += 1) {
      const dict = CFArrayGetValueAtIndex(array, index);
      if (!dict) continue;
      const boundsDict = CFDictionaryGetValue(dict, keys.bounds);
      const bounds = boundsDict
        ? {
            x: readInt(boundsDict, keys.x) ?? 0,
            y: readInt(boundsDict, keys.y) ?? 0,
            width: readInt(boundsDict, keys.width) ?? 0,
            height: readInt(boundsDict, keys.height) ?? 0,
          }
        : undefined;
      result.push({
        windowId: readInt(dict, keys.number),
        pid: readInt(dict, keys.pid),
        layer: readInt(dict, keys.layer) ?? 0,
        ownerName: readString(dict, keys.owner),
        bounds,
      });
    }
    return result;
  };
}

/**
 * 前到后序选前台应用窗口（纯函数）：
 *   layer===0 && pid 不在排除集 && 尺寸达标（bounds 缺席的极老窗口跳过）。
 */
export function pickFrontmostAppWindow(windows, options = {}) {
  const excludePids = new Set(options.excludePids ?? []);
  const min = { ...FRONTMOST_MIN_WINDOW_SIZE, ...(options.minSize ?? {}) };
  for (const window of windows) {
    if (!window || window.layer !== 0) continue;
    if (Number.isInteger(window.pid) && excludePids.has(window.pid)) continue;
    if (!Number.isInteger(window.windowId)) continue;
    const bounds = window.bounds;
    if (!bounds || bounds.width < min.width || bounds.height < min.height) continue;
    return window;
  }
  return undefined;
}

/** 截窗口 PNG（screencapture -l<id>；无屏幕录制 TCC 时失败结构化返回）。 */
export async function captureWindowPng(windowId, outPath) {
  try {
    await execFileText(SCREENCAPTURE_PATH, ["-l", String(windowId), "-x", outPath], SCREENCAPTURE_TIMEOUT_MS);
    const info = await stat(outPath);
    if (info.size === 0) {
      return { ok: false, error: { code: "screen_capture_denied", message: "screencapture produced an empty file — grant Screen Recording to FreeCodeZ" } };
    }
    return { ok: true, path: outPath, bytes: info.size };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "screen_capture_failed",
        message: `screencapture -l ${windowId} failed: ${String(error?.message ?? error)}`,
      },
    };
  }
}

/**
 * Appshot 快照：前台窗口截图 + 该应用的 AX 树（Phase 1 复用）。
 * 截屏被拒时仍返回 AX 树（note 说明）——AX 部分不需要屏幕录制权限。
 */
export async function appshotSnapshot(options = {}) {
  const bindings = loadKoffiBindings();
  if (!bindings) {
    return { ok: false, error: { code: "cua_koffi_error", message: "koffi bindings unavailable" } };
  }
  const reader = options.readWindows ?? buildOnScreenWindowsReader(bindings);
  const windows = reader();
  const frontmost = pickFrontmostAppWindow(windows, {
    excludePids: options.excludePids ?? [process.pid],
  });
  if (!frontmost) {
    return { ok: false, error: { code: "no_frontmost_window", message: "no qualifying frontmost app window found" } };
  }
  const base = {
    app: { pid: frontmost.pid, name: frontmost.ownerName ?? "" },
    windowId: frontmost.windowId,
    bounds: frontmost.bounds,
  };
  const tree = await readApplicationTree(frontmost.pid);
  const capture = options.capture
    ? await options.capture(frontmost.windowId)
    : await (async () => {
        const dir = await mkdtemp(join(tmpdir(), "appshot-"));
        const path = join(dir, `appshot-${frontmost.windowId}-${Date.now()}.png`);
        const result = await captureWindowPng(frontmost.windowId, path);
        if (!result.ok) await rm(dir, { recursive: true, force: true });
        return result;
      })();
  if (!capture.ok) {
    return {
      ok: true,
      ...base,
      capture: undefined,
      captureError: capture.error,
      axTree: tree.ok ? { elementCount: tree.nodeCount ?? 0, note: tree.note } : { elementCount: 0, note: tree.note ?? "ax unavailable" },
      note: `${capture.error?.message ?? "capture failed"}; AX tree ${tree.ok ? `captured (${tree.nodeCount ?? 0} nodes)` : "unavailable"}`,
    };
  }
  return {
    ok: true,
    ...base,
    capture: { path: capture.path, bytes: capture.bytes },
    axTree: tree.ok ? { elementCount: tree.nodeCount ?? 0 } : { elementCount: 0, note: "ax unavailable" },
  };
}
