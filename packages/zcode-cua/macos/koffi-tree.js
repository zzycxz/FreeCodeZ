// ============================================================
// Phase 1-d 支撑件：元素句柄表 / app_ref 解析 / AX 树扁平化 / App 指南加载
// （从 koffi-broker-methods.js 拆出——该文件抵 400 行门；本文件只含无状态工具）
// ============================================================

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadKoffiBindings,
  withCFString,
  cfStringToJs,
  cfArrayToRefs,
  cfBooleanToJs,
  AXError,
} from "./koffi-ax.js";
import { parseLsappinfoList, MAX_TREE_NODES } from "./ax-observation.js";

const LSAPPINFO_PATH = "/usr/bin/lsappinfo";
const LSAPPINFO_TIMEOUT_MS = 4_000;
/** 元素句柄 TTL：观测后 5 分钟内可动作；超时重建观测。 */
const ELEMENT_HANDLE_TTL_MS = 5 * 60_000;
/** 句柄表上限（LRU 淘汰）。 */
const MAX_ELEMENT_HANDLES = 2_000;
const SCREEN_CAPTURE_PROBE_TIMEOUT_MS = 4_000;

// ── App 操作指南（P1-e）─────────────────────────────────────
// ZCode 基线能力：capture_app 按 bundle_id 匹配注入 advisory 文本。
// 文件在 packages/zcode-cua/app-instructions/<bundle_id>.md；缺席即无注入。

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const APP_INSTRUCTIONS_DIR = join(MODULE_DIR, "..", "app-instructions");

export function loadAppInstruction(bundleId) {
  if (!bundleId || typeof bundleId !== "string") return undefined;
  const safeName = bundleId.toLowerCase().replace(/[^a-z0-9._-]/gu, "");
  if (!safeName) return undefined;
  const path = join(APP_INSTRUCTIONS_DIR, `${safeName}.md`);
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// ── 元素句柄表 ─────────────────────────────────────────────

export class ElementHandleTable {
  #entries = new Map();

  issue(ref, pid) {
    // LRU：超限先淘汰最旧。
    while (this.#entries.size >= MAX_ELEMENT_HANDLES) {
      const oldest = this.#entries.keys().next().value;
      const entry = this.#entries.get(oldest);
      this.#entries.delete(oldest);
      try {
        loadKoffiBindings()?.CFRelease(entry?.ref);
      } catch {
        // 淘汰释放失败不影响新句柄发放。
      }
    }
    const handle = `koffi-el-${randomUUID()}`;
    this.#entries.set(handle, { ref, pid, issuedAt: Date.now() });
    return handle;
  }

  resolve(handle) {
    const entry = this.#entries.get(handle);
    if (!entry) return undefined;
    if (Date.now() - entry.issuedAt > ELEMENT_HANDLE_TTL_MS) {
      this.#entries.delete(handle);
      try {
        loadKoffiBindings()?.CFRelease(entry.ref);
      } catch {
        // 过期释放失败同上。
      }
      return undefined;
    }
    return entry;
  }

  disposeAll() {
    const bindings = loadKoffiBindings();
    for (const [, entry] of this.#entries) {
      try {
        bindings?.CFRelease(entry.ref);
      } catch {
        // 进程退出路径，尽力而为。
      }
    }
    this.#entries.clear();
  }
}

// ── 工具函数 ───────────────────────────────────────────────

function execFileText(file, args, timeoutMs = LSAPPINFO_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** app_ref（bundle_id 字符串或 {bundle_id|pid}）→ pid。 */
export async function resolveAppRefToPid(appRef) {
  if (appRef && typeof appRef === "object" && Number.isInteger(appRef.pid) && appRef.pid > 0) {
    return appRef.pid;
  }
  const bundleId =
    typeof appRef === "string"
      ? appRef.trim()
      : appRef && typeof appRef === "object" && typeof appRef.bundle_id === "string"
        ? appRef.bundle_id.trim()
        : "";
  if (!bundleId) return undefined;
  let stdout;
  try {
    stdout = await execFileText(LSAPPINFO_PATH, ["list"]);
  } catch {
    return undefined;
  }
  const apps = parseLsappinfoList(stdout);
  const match = apps.find((app) => app.bundleId?.toLowerCase() === bundleId.toLowerCase());
  return match?.pid;
}

/** 读元素字符串属性数组（AXActions→AXPress 等）。 */
export function copyActionNames(bindings, element) {
  const out = [null];
  try {
    const err = bindings.AXUIElementCopyActionNames(element, out);
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

/** AXValue struct 读数（与 ax-observation 同实现；独立于此避免私有耦合）。 */
export function readStruct(bindings, ref, kind) {
  if (!ref) return undefined;
  const out = new ArrayBuffer(16);
  let ok;
  try {
    ok = bindings.AXValueGetValue(ref, kind, out);
  } catch {
    return undefined;
  }
  if (!ok) return undefined;
  const values = new Float64Array(out);
  return kind === 1 ? { x: values[0], y: values[1] } : { width: values[0], height: values[1] };
}

export function copyString(bindings, element, attribute) {
  return withCFString(bindings, attribute, (name) => {
    const out = [null];
    const err = bindings.AXUIElementCopyAttributeValue(element, name, out);
    return err === AXError.Success ? cfStringToJs(bindings, out[0]) : undefined;
  });
}

export function copyStruct(bindings, element, attribute, kind) {
  return withCFString(bindings, attribute, (name) => {
    const out = [null];
    const err = bindings.AXUIElementCopyAttributeValue(element, name, out);
    return err === AXError.Success ? readStruct(bindings, out[0], kind) : undefined;
  });
}

export function copyBool(bindings, element, attribute) {
  return withCFString(bindings, attribute, (name) => {
    const out = [null];
    const err = bindings.AXUIElementCopyAttributeValue(element, name, out);
    return err === AXError.Success ? (cfBooleanToJs(bindings, out[0]) ?? false) : false;
  });
}

export function copyChildren(bindings, element) {
  return withCFString(bindings, "AXChildren", (name) => {
    const out = [null];
    const err = bindings.AXUIElementCopyAttributeValue(element, name, out);
    return err === AXError.Success ? cfArrayToRefs(bindings, out[0]) : [];
  });
}

// ── 表面分类与生命周期（P1-f，2026-10-06 真机实测驱动） ────────────────
// 实测证据（TextEdit ⌘S 探证）：保存面板以 AXSheet 挂在窗口上且 AXSubrole 为空——
// 区分 save_panel/open_panel 只能靠内容特征（子树主按钮：保存/取消 + 「保存为：」
// 文本框）。标题集覆盖 zh/en（日文「保存」同形）；未覆盖语种回落 attached_dialog，
// 行为不劣于现状。

const PANEL_SAVE_BUTTON_TITLES = new Set(["save", "save as", "保存", "存储", "保存为"]);
const PANEL_OPEN_BUTTON_TITLES = new Set(["open", "打开"]);

/** 纯判定：save 优先于 open（保存面板也可能带打开类次级按钮）。 */
export function sheetPanelKindFromButtons(hasSave, hasOpen) {
  if (hasSave) return "save_panel";
  if (hasOpen) return "open_panel";
  return "attached_dialog";
}

/** 有界子树探测（depth≤4/节点≤60——sheet 少见，非 sheet 路径零成本）。 */
function probePanelButtons(bindings, element, depth = 0, budget = { used: 0 }) {
  const found = { save: false, open: false };
  if (!element || depth > 4 || budget.used >= 60) return found;
  budget.used += 1;
  const role = copyString(bindings, element, "AXRole");
  if (role === "AXButton") {
    const title = (copyString(bindings, element, "AXTitle") ?? "").trim().toLowerCase();
    if (PANEL_SAVE_BUTTON_TITLES.has(title)) found.save = true;
    else if (PANEL_OPEN_BUTTON_TITLES.has(title)) found.open = true;
  }
  if (found.save && found.open) return found;
  const children = copyChildren(bindings, element);
  for (const child of children) {
    if (!child) continue;
    const sub = probePanelButtons(bindings, child, depth + 1, budget);
    found.save = found.save || sub.save;
    found.open = found.open || sub.open;
    if (found.save && found.open) return found;
  }
  return found;
}

/**
 * 窗口表面集快照差分（P1-f 生命周期）：stable=与上次一致；replaced=集合有增减但
 * 仍有表面；closed=上次有表面本次全无（或本次已无窗口）。首次观测=stable。
 * AXObserver 实时监听是手册终态形态；快照差分在无监听现状下给出等值判定。
 * 指纹用 kind+title（sheet 常无标题；bounds 会被窗口移动污染故不参与）。
 */
export function surfaceLifecycleFromDiff(previous, current, options = {}) {
  if (!previous) return "stable";
  if (options.hasWindow === false) return "closed";
  const anyGone = [...previous].some((fingerprint) => !current.has(fingerprint));
  const anyNew = [...current].some((fingerprint) => !previous.has(fingerprint));
  if (anyGone && current.size === 0) return "closed";
  if (anyGone || anyNew) return "replaced";
  return "stable";
}

/**
 * 树扁平化（capture_app 的 elements[] 是**扁平**列表，每项带 native 句柄 + depth；
 * 与 Windows Helper 一致——producer 侧按 depth 缩进渲染）。
 */
export function flattenTree(bindings, handles, pid, element, depth, budget) {
  if (depth > 12 || budget.used >= MAX_TREE_NODES) return;
  const role = copyString(bindings, element, "AXRole");
  if (!role) return;
  budget.used += 1;
  const title = copyString(bindings, element, "AXTitle");
  const value = copyString(bindings, element, "AXValue");
  const description = copyString(bindings, element, "AXDescription");
  const roleDescription = copyString(bindings, element, "AXRoleDescription");
  const position = copyStruct(bindings, element, "AXPosition", 1);
  const size = copyStruct(bindings, element, "AXSize", 2);
  const focused = copyBool(bindings, element, "AXFocused");
  const actions = copyActionNames(bindings, element);
  // Get 惯例：数组内元素 ref 归数组；句柄表要持有它就必须显式 +1（2026-10-05
  // 教训：直接登记导致数组释放后句柄悬空 + 双重释放崩溃 exit 133）。
  bindings.CFRetain(element);
  const native = handles.issue(element, pid);
  const surfaceKind =
    role === "AXSheet"
      ? (() => {
          const panelButtons = probePanelButtons(bindings, element);
          return sheetPanelKindFromButtons(panelButtons.save, panelButtons.open);
        })()
      : role === "AXPopover" || role === "AXDrawer"
        ? "popover"
        : depth === 0 && role === "AXWindow"
          ? "window"
          : undefined;
  budget.elements.push({
    role,
    ...(title ? { title } : {}),
    ...(value ? { value } : {}),
    ...(description ? { description } : {}),
    ...(roleDescription ? { role_description: roleDescription } : {}),
    ...(position && size
      ? { bounds: [position.x, position.y, size.width, size.height] }
      : {}),
    focused,
    actions,
    pressable: actions.includes("AXPress"),
    has_menu: actions.includes("AXShowMenu"),
    native,
    owner_pid: pid,
    depth,
    ...(surfaceKind ? { surface_kind: surfaceKind } : {}),
  });
  const children = copyChildren(bindings, element);
  for (const child of children) {
    if (!child) continue;
    flattenTree(bindings, handles, pid, child, depth + 1, budget);
    if (budget.used >= MAX_TREE_NODES) break;
  }
}


/**
 * 从 element 起向下找第一个 AXValue 可设的元素（深度优先，depth 上限）。
 * 聚焦元素常是容器（window/scroll area），真正可写的文本区在其子树。
 * 返回 undefined = 子树内无可设元素。
 */
export function findSettableValueElement(bindings, element, depth = 0) {
  if (!element || depth > 6) return undefined;
  const settable = withCFString(bindings, "AXValue", (valueName) => {
    const out = new ArrayBuffer(4);
    const err = bindings.AXUIElementIsAttributeSettable(element, valueName, out);
    if (err !== 0) return false;
    return new DataView(out).getUint8(0) !== 0;
  });
  if (settable) return element;
  for (const child of copyChildren(bindings, element)) {
    if (!child) continue;
    const found = findSettableValueElement(bindings, child, depth + 1);
    if (found && found !== child) {
      // 找到的子元素归数组所有——持有前 retain（Get 惯例）。
      bindings.CFRetain(found);
      return found;
    }
    if (found === child) return child;
  }
  return undefined;
}
