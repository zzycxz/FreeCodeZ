// ============================================================
// Phase 3a：Appshot 桌面装配（升级实施手册 桌面控制 3a）
// ============================================================
// 双击修饰键（默认关；FREECODEZ_APPSHOT_HOTKEY=cmd|alt|shift|off）→
// appshotSnapshot（前台窗截图 + AX 树）→ 聚焦窗口渲染进程派发
// CustomEvent("freecodez:appshot-add-to-chat")，由聚焦 composer 的附件钩子消费
//（与 whiteboard add-to-chat 同款聚焦门控）。截屏被 TCC 拒时仍注入 AX 摘要文本。
import { appshotSnapshot } from "@zcode/zcode-cua/macos";
import { createModifierDoubleTapWatcher } from "@zcode/zcode-cua/macos";

export const APPSHOT_ADD_TO_CHAT_EVENT = "freecodez:appshot-add-to-chat";
export const APPSHOT_HOTKEY_ENV = "FREECODEZ_APPSHOT_HOTKEY";

export type AppshotHotkeySetting = "cmd" | "alt" | "shift" | "off";

export function resolveAppshotHotkeySetting(value: string | undefined): AppshotHotkeySetting {
  const trimmed = value?.trim();
  return trimmed === "cmd" || trimmed === "alt" || trimmed === "shift" || trimmed === "off"
    ? trimmed
    : "off";
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
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  runSnapshot?: typeof appshotSnapshot;
  log?: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * 启动 Appshot 热键监听。默认（无 env / off）返回 no-op——三道保险同族：
 * 显式开启才有全局轮询与注入行为。
 */
export function startCuaAppshot(deps: CuaAppshotDeps) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const setting = resolveAppshotHotkeySetting(env[APPSHOT_HOTKEY_ENV]);
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
  const detail = {
    app: snapshot.app,
    windowId: snapshot.windowId,
    path: snapshot.capture?.path,
    pngBytes: snapshot.capture?.bytes ?? 0,
    axElementCount: snapshot.axTree?.elementCount ?? 0,
    note: snapshot.note,
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
