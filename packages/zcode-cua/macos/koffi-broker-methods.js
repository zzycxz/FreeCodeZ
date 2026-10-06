// ============================================================
// Phase 1-d：koffi 进程内 broker 方法表（升级实施手册 桌面控制 Phase 1）
// ============================================================
// 传输旁路：createComputerUseRuntime({ inProcessMethods }) 时 callBroker 直接查表，
// 不走 Unix socket（mac 无 Helper 进程）。方法形状逐项对齐 Windows broker 协议
//（producer/tool-handlers.js 的调用点为契约来源）。
//
// 三道保险（手册 §Phase1 ⚠）：
//   1. 总开关 FREECODEZ_CUA_KOFFI_EXECUTION=1（node-repl-host 捕获函数判定，旧键
//      ZCODE_CUA_KOFFI_EXECUTION 回退读），默认关；
//   2. 动作面二次开关 FREECODEZ_CUA_KOFFI_ACTIONS=1——缺省只暴露观测/诊断面；
//   3. 绑定不可用/TCC 未授 → 工厂返回 null，上层回 socket/不可用路径（fail-closed）。
//
// 未收录方法（pip_*/controller_*/prevent_activation 族）→ 表中无键 → 上层报
// unknown/unavailable，与"Helper 未实现该方法"的既有语义一致。

import {
  loadKoffiBindings,
  withCFString,
  describeAxError,
  AXError,
} from "./koffi-ax.js";
import {
  listApplications,
  listWindows,
} from "./ax-observation.js";
import { registerDiagnosticMethods } from "./koffi-diagnostics.js";
import {
  ElementHandleTable,
  findSettableValueElement,
  resolveAppRefToPid,
  copyString,
  copyActionNames,
  loadAppInstruction,
  surfaceLifecycleFromDiff,
  buildCaptureAppPayload,
} from "./koffi-tree.js";
import {
  clickAtPoint,
  scrollAtPoint,
  pressKey,
  typeAsciiText,
  elementSetValue,
  elementPerformAction,
} from "./ax-actions.js";
import {
  cursorEventsForClick,
  cursorEventsForDrag,
  cursorEventsForKey,
  cursorEventsForText,
  emitCursorEvents,
} from "./cursor-events.js";
import {
  createUserActivityReader,
  wrapMethodsWithActivityGate,
} from "./user-activity-gate.js";

// Phase 2 干预闭环：套用户活动闸的动作方法名（观测/诊断面不拦——只读无交互冲突）。
const GATED_ACTION_METHOD_NAMES = [
  "click",
  "scroll",
  "press_key",
  "type_text",
  "type_text_to_app",
  "paste",
  "drag",
  "element_press",
  "element_show_menu",
  "element_perform_action",
  "element_focus",
  "element_set_value",
];

// ── 方法表工厂 ─────────────────────────────────────────────

/**
 * 创建 koffi 进程内 broker 方法表。
 * @returns 记录集（方法名 → async (params) => result）或 null（不可用 fail-closed）。
 */
export function createKoffiBrokerMethods(options = {}) {
  const bindings = loadKoffiBindings();
  if (!bindings) return null;
  const allowActions = options.allowActions === true;
  // Phase 2-1a：输入事件旁路（HUD 光标消费）。发射失败不影响动作本体。
  const onInputEvent = typeof options.onInputEvent === "function" ? options.onInputEvent : null;
  const emit = (events) => emitCursorEvents(onInputEvent, events);
  const handles = new ElementHandleTable();
  // P1-f 表面生命周期差分状态：pid → 上次 capture_app 的表面指纹集。
  // 无会话语义（broker 生命周期=进程内链路开启期），重启回落 stable（首次观测语义）。
  const lastSurfaceSets = new Map();
  const methods = {};

  registerDiagnosticMethods(methods, { allowActions });

  // ── 观测面 ──
  methods.list_applications = async () => {
    const result = await listApplications();
    if (!result.ok) return result;
    return { ok: true, apps: result.applications };
  };

  methods.list_windows = async (params) => {
    const pid = await resolveAppRefToPid(params?.app_ref);
    if (pid === undefined) {
      return { ok: false, error: { code: "app_not_found", message: `cannot resolve app_ref to a running application` } };
    }
    const result = await listWindows(pid);
    if (!result.ok) return result;
    return {
      ok: true,
      windows: result.windows.map((window, index) => ({
        window_id: index + 1,
        ...window,
      })),
    };
  };

  methods.capture_app = async (params) => {
    const pid = await resolveAppRefToPid(params?.app_ref);
    if (pid === undefined) {
      return { ok: false, error: { code: "app_not_found", message: "cannot resolve app_ref to a running application" } };
    }
    return buildCaptureAppPayload({ bindings, handles, lastSurfaceSets, pid, params });
  };

  methods.read_element = async (params) => {
    const entry = handles.resolve(params?.native);
    if (!entry) {
      return { ok: false, error: { code: "stale_element", message: "element handle expired or unknown; re-observe" } };
    }
    const role = copyString(bindings, entry.ref, "AXRole");
    return {
      ok: true,
      element: {
        role: role ?? "",
        title: copyString(bindings, entry.ref, "AXTitle") ?? "",
        value: copyString(bindings, entry.ref, "AXValue"),
        actions: copyActionNames(bindings, entry.ref),
        owner_pid: entry.pid,
      },
    };
  };

  methods.element_at_point = async (params) => {
    // 简化实现：全局点 → 含该点的可见窗口（CGWindowList 语义由 lsappinfo+AX bounds 替代）。
    // 精确 hittest（AXUIElementCopyAttributeValue(systemWide, kAXAccessibilityHitTest)）
    // 依赖 systemWide 路径（本机实测 -25204），Phase 1 用窗口 bounds 包含判定。
    const x = Number(params?.point?.[0] ?? params?.x);
    const y = Number(params?.point?.[1] ?? params?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, error: { code: "invalid_params", message: "point must be [x, y]" } };
    }
    const result = await listApplications();
    if (!result.ok) return result;
    for (const app of result.applications) {
      if (app.windowCount === 0) continue;
      const windows = await listWindows(app.pid);
      if (!windows.ok) continue;
      for (const window of windows.windows) {
        const bounds = window.bounds;
        if (!bounds) continue;
        if (x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height) {
          return {
            ok: true,
            app: { pid: app.pid, bundle_id: app.bundleId, name: app.name },
            window: { window_id: 1, title: window.title, bounds },
          };
        }
      }
    }
    return { ok: false, error: { code: "no_window_at_point", message: `no visible window contains point (${x}, ${y})` } };
  };

  // ── 动作面（阶段开关 2）──
  if (allowActions) {
    methods.click = async (params) => {
      const point = params?.point;
      const x = Number(Array.isArray(point) ? point[0] : point?.x);
      const y = Number(Array.isArray(point) ? point[1] : point?.y);
      const button = params?.button === "right" || params?.button === "middle" ? params.button : "left";
      emit(cursorEventsForClick({ x, y, button }));
      const result = clickAtPoint({
        x,
        y,
        button,
        clickCount: Math.max(1, Math.min(Number(params?.clicks) || 1, 3)),
      });
      return result.ok
        ? { ok: true, action_sent: true, dispatch_status: "delivered", strategy: "event" }
        : result;
    };

    methods.scroll = async (params) => {
      const point = params?.point;
      const result = scrollAtPoint({
        x: Number(Array.isArray(point) ? point[0] : point?.x ?? 0),
        y: Number(Array.isArray(point) ? point[1] : point?.y ?? 0),
        deltaX: Number(params?.delta_x ?? params?.deltaX ?? 0),
        deltaY: Number(params?.delta_y ?? params?.deltaY ?? params?.amount ?? 0),
        unit: params?.unit === "pixel" ? "pixel" : "line",
      });
      return result.ok ? { ok: true, action_sent: true, dispatch_status: "delivered" } : result;
    };

    methods.press_key = async (params) => {
      emit(cursorEventsForKey({ key: params?.key }));
      const result = pressKey({ key: params?.key });
      return result.ok ? { ok: true, action_sent: true, dispatch_status: "delivered" } : result;
    };

    methods.type_text = async (params) => {
      emit(cursorEventsForText({ text: params?.text }));
      const result = typeAsciiText({ text: params?.text });
      return result.ok
        ? { ok: true, action_sent: true, dispatch_status: "delivered", typed: result.typed }
        : result;
    };

    methods.type_text_to_app = async (params) => {
      // AX set_value 是 CJK 安全正路；app_ref 定位应用焦点元素。
      const pid = await resolveAppRefToPid(params?.app_ref);
      if (pid === undefined) {
        return { ok: false, error: { code: "app_not_found", message: "cannot resolve app_ref" } };
      }
      let appEl;
      try {
        appEl = bindings.AXUIElementCreateApplication(pid);
      } catch (error) {
        return { ok: false, error: { code: "cua_koffi_error", message: String(error) } };
      }
      try {
        const focused = withCFString(bindings, "AXFocusedUIElement", (name) => {
          const out = [null];
          const err = bindings.AXUIElementCopyAttributeValue(appEl, name, out);
          return err === AXError.Success ? out[0] : undefined;
        });
        if (!focused) {
          return {
            ok: false,
            error: { code: "ax_error", message: "no focused element in target app (AXError CannotComplete)" },
          };
        }
        try {
          // 聚焦元素常是容器（TextEdit=scroll area）：下降找第一个 AXValue 可设元素。
          const target = findSettableValueElement(bindings, focused) ?? focused;
          const result = elementSetValue({ elementRef: target, value: params?.text });
          if (target !== focused) {
            try {
              bindings.CFRelease(target);
            } catch {
              // 释放尽力。
            }
          }
          return result.ok
            ? { ok: true, action_sent: true, dispatch_status: "delivered", strategy: "a11y_set_value" }
            : result;
        } finally {
          try {
            bindings.CFRelease(focused);
          } catch {
            // 同上。
          }
        }
        return result.ok
          ? { ok: true, action_sent: true, dispatch_status: "delivered", strategy: "a11y_set_value" }
          : result;
      } finally {
        try {
          bindings.CFRelease(appEl);
        } catch {
          // 同上。
        }
      }
    };

    const elementAction = (fn) => async (params) => {
      const entry = handles.resolve(params?.native);
      if (!entry) {
        return { ok: false, error: { code: "stale_element", message: "element handle expired or unknown; re-observe" } };
      }
      const result = await fn(entry);
      return result.ok
        ? { ok: true, action_sent: true, dispatch_status: "delivered" }
        : result;
    };

    methods.element_press = elementAction(async (entry) =>
      elementPerformAction({ elementRef: entry.ref, action: "AXPress" }),
    );
    methods.element_show_menu = elementAction(async (entry) =>
      elementPerformAction({ elementRef: entry.ref, action: "AXShowMenu" }),
    );
    methods.element_perform_action = elementAction(async (entry, params) =>
      elementPerformAction({ elementRef: entry.ref, action: params?.action ?? "AXPress" }),
    );
    methods.element_focus = elementAction(async (entry) => {
      return withCFString(bindings, "AXFocused", (name) =>
        withCFString(bindings, "true", (valueRef) => {
          try {
            const err = bindings.AXUIElementSetAttributeValue(entry.ref, name, valueRef);
            return err === AXError.Success
              ? { ok: true }
              : { ok: false, error: { code: "ax_error", message: describeAxError(err) } };
          } catch (error) {
            return { ok: false, error: { code: "cua_koffi_error", message: String(error) } };
          }
        }),
      );
    });
    methods.element_set_value = elementAction(async (entry, params) =>
      elementSetValue({ elementRef: entry.ref, value: params?.value }),
    );

    methods.paste = async () => {
      // macOS 粘贴 = cmd+v 合成（剪贴板内容由上层工具链准备）。
      const result = pressKey({ key: "cmd+v" });
      return result.ok ? { ok: true, action_sent: true, dispatch_status: "delivered" } : result;
    };

    methods.drag = async (params) => {
      // 最小可用实现：起点按下 → 终点释放（无中途插值；Phase 2 按需补平滑）。
      const from = params?.from_point ?? params?.from;
      const to = params?.to_point ?? params?.to;
      const fx = Number(Array.isArray(from) ? from[0] : from?.x);
      const fy = Number(Array.isArray(from) ? from[1] : from?.y);
      const tx = Number(Array.isArray(to) ? to[0] : to?.x);
      const ty = Number(Array.isArray(to) ? to[1] : to?.y);
      if (![fx, fy, tx, ty].every(Number.isFinite)) {
        return { ok: false, error: { code: "invalid_params", message: "drag needs from_point and to_point" } };
      }
      emit(cursorEventsForDrag({ fromX: fx, fromY: fy, toX: tx, toY: ty }));
      let source;
      try {
        source = bindings.CGEventSourceCreate(0);
      } catch (error) {
        return { ok: false, error: { code: "cua_koffi_error", message: String(error) } };
      }
      try {
        const post = (type, x, y) => {
          const event = bindings.CGEventCreateMouseEvent(source, type, x, y, 0);
          if (!event) throw new Error("CGEventCreateMouseEvent returned null");
          try {
            bindings.CGEventPost(0, event);
          } finally {
            bindings.CFRelease(event);
          }
        };
        post(1, fx, fy); // LeftMouseDown
        const steps = 12;
        for (let step = 1; step <= steps; step += 1) {
          post(5, fx + ((tx - fx) * step) / steps, fy + ((ty - fy) * step) / steps); // MouseMoved
        }
        post(2, tx, ty); // LeftMouseUp
        return { ok: true, action_sent: true, dispatch_status: "delivered" };
      } catch (error) {
        return { ok: false, error: { code: "cua_koffi_error", message: String(error) } };
      } finally {
        try {
          bindings.CFRelease(source);
        } catch {
          // 同上。
        }
      }
    };
  }

  // ── Phase 2 干预闭环：动作面用户活动闸（手册 v4.2 挂账收口）──
  // 规格后半段"用户动真鼠标→暂停→等静默后才续跑"的执行侧：HUD 只冻结视觉，
  // 这里保证动作本体不落在用户正在操作的鼠标下。持续活跃超时 fail-closed 返回
  // user_active（可重试不熔断）；检测器缺席放行（干预面缺席不折断动作）。
  // options.readUserActivity 可注入（测试用）；options.userActivityGateOptions 覆盖阈值。
  if (allowActions) {
    wrapMethodsWithActivityGate(
      methods,
      GATED_ACTION_METHOD_NAMES,
      typeof options.readUserActivity === "function"
        ? options.readUserActivity
        : createUserActivityReader(bindings),
      options.userActivityGateOptions,
    );
  }

  return {
    methods,
    dispose: () => handles.disposeAll(),
    allowActions,
  };
}
