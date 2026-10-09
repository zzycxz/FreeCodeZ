// ============================================================
// Phase 3a：Appshot 桌面装配（升级实施手册 桌面控制 3a）
// ============================================================
// 双击修饰键（默认关；FREECODEZ_APPSHOT_HOTKEY=cmd|alt|shift|off）→
// appshotSnapshot（前台窗截图 + AX 树）→ 聚焦窗口渲染进程派发
// CustomEvent("freecodez:appshot-add-to-chat")，由聚焦 composer 的附件钩子消费
//（与 whiteboard add-to-chat 同款聚焦门控）。截屏被 TCC 拒时仍注入 AX 摘要文本。
import { appshotSnapshot, createModifierDoubleTapWatcher } from "@zcode/zcode-cua/macos";
import { ensureMainScreenRecordingRegistration } from "./cuaScreenRecordingRegistration.js";

export const APPSHOT_ADD_TO_CHAT_EVENT = "freecodez:appshot-add-to-chat";
export const APPSHOT_HOTKEY_ENV = "FREECODEZ_APPSHOT_HOTKEY";

export type AppshotHotkeySetting = "cmd" | "alt" | "shift" | "off";

export function resolveAppshotHotkeySetting(value: string | undefined): AppshotHotkeySetting {
  const trimmed = value?.trim();
  return trimmed === "cmd" || trimmed === "alt" || trimmed === "shift" || trimmed === "off"
    ? trimmed
    : "off";
}

/** 设置键的协议形态（appshotHotkey）→ 热键档。 */
export function hotkeyFromSettings(value: unknown): AppshotHotkeySetting {
  return value === "cmd" || value === "alt" || value === "shift" ? value : "off";
}

export interface CuaAppshotWindowTarget {
  isDestroyed(): boolean;
  webContents: {
    getURL(): string;
    executeJavaScript(code: string): Promise<unknown>;
  };
}

export interface CuaAppshotDeps {
  getFocusedWindow(): CuaAppshotWindowTarget | undefined;
  /** Phase 3a 设置面（注入式读取，缺省=无设置全走 env）。 */
  getAppshotSettings?(): { appshotHotkey?: string; appshotSound?: boolean; appshotRoute?: string };
  /** Phase 3a 音效（注入式；缺省无声）。 */
  playSound?(): void;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  runSnapshot?: typeof appshotSnapshot;
  /** R21 录屏自注册：授权预检/请求（注入式；缺省 koffi 进程内真实现）。 */
  probeScreenCapture?: () => boolean;
  requestScreenCaptureAccess?: () => void;
  log?: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * 启动 Appshot 热键监听。默认（无 env / off）返回 no-op——三道保险同族：
 * 显式开启才有全局轮询与注入行为。
 */
export function startCuaAppshot(deps: CuaAppshotDeps) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  // Phase 3a 设置面：设置键优先（UI 可控）；env 为部署覆盖兜底；缺省 off。
  const settingsHotkey = hotkeyFromSettings(deps.getAppshotSettings?.().appshotHotkey);
  const setting =
    settingsHotkey !== "off"
      ? settingsHotkey
      : resolveAppshotHotkeySetting(env[APPSHOT_HOTKEY_ENV]);
  if (setting === "off" || platform !== "darwin") {
    return { stop: () => undefined, enabled: false };
  }
  const watcher = createModifierDoubleTapWatcher({
    modifier: setting,
    onTrigger: () => {
      void triggerAppshot(deps);
    },
    platform,
  });
  return {
    stop() {
      watcher.stop();
    },
    enabled: watcher.available,
    /** 手动触发通道（菜单项/测试；与热击同路径）。 */
    trigger: () => {
      void triggerAppshot(deps);
    },
  };
}

async function triggerAppshot(deps: CuaAppshotDeps) {
  const window = deps.getFocusedWindow();
  if (!window || window.isDestroyed() || window.webContents.getURL().startsWith("devtools://")) {
    return;
  }
  if (deps.getAppshotSettings?.().appshotSound !== false) deps.playSound?.();
  // R21/R21b（2026-10-08/09 用户裁决「屏幕录制列表必须有 FreeCodeZ」）：Appshot 截屏主体是
  // 主应用（spawn screencapture），不自注册就进不了系统「屏幕录制」列表、无处授权。截屏前
  // 预检，未授权先请求（共享实现；权限状态已定时零弹窗、拒绝后不重弹）。请求失败不阻断
  // 截屏——照常走快照，被拒时仍注入 AX 摘要。
  ensureMainScreenRecordingRegistration({
    probeScreenCapture: deps.probeScreenCapture,
    requestScreenCaptureAccess: deps.requestScreenCaptureAccess,
    log: deps.log,
  });
  const snapshot = deps.runSnapshot
    ? await deps.runSnapshot()
    : await appshotSnapshot({ excludePids: [process.pid] });
  if (!snapshot.ok) {
    deps.log?.("Appshot skipped: no qualifying frontmost window", {
      event: "cua.appshot.skipped",
      reason: snapshot.error?.code,
    });
    return;
  }
  const route = deps.getAppshotSettings?.().appshotRoute === "new" ? "new" : "current";
  const detail = {
    app: snapshot.app,
    windowId: snapshot.windowId,
    path: snapshot.capture?.path,
    pngBytes: snapshot.capture?.bytes ?? 0,
    axElementCount: snapshot.axTree?.elementCount ?? 0,
    note: snapshot.note,
    route,
    takenAt: Date.now(),
  };
  const dispatch = `window.dispatchEvent(new CustomEvent(${JSON.stringify(
    APPSHOT_ADD_TO_CHAT_EVENT,
  )},{detail:${JSON.stringify(detail)}}))`;
  try {
    await window.webContents.executeJavaScript(dispatch);
    deps.log?.("Appshot delivered to focused window", {
      event: "cua.appshot.delivered",
      app: detail.app?.name,
      hasImage: Boolean(detail.path),
      axElementCount: detail.axElementCount,
    });
  } catch (error) {
    deps.log?.("Appshot dispatch failed", {
      event: "cua.appshot.dispatch_failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
