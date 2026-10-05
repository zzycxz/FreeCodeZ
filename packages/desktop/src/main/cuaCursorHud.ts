// ============================================================
// Phase 2-1c：CUA 光标 HUD（升级实施手册 桌面控制 Phase 2 第一步）
// ============================================================
// 组成：UDP 监听（执行层广播的输入事件）→ 两个透明覆盖窗：
//   1. 光标窗：frameless 透明 click-through，光标 SVG + 点击脉冲（CSS 变换）；
//   2. 横幅窗：顶部"FreeCodeZ 正在使用你的电脑 · 停止任务可取消"。
// 纪律：
//   - 全部窗口 ignoreMouseEvents + focusable:false —— HUD 永不抢输入/焦点
//     （与 cuaPermissionDragPanel 的 panel 论证同源）；
//   - 惰性建窗：首个事件到达才创建；6 秒无事件自动隐藏（会话静默）；
//   - 事件解析失败静默丢弃（HUD 是旁路可视化，坏帧不崩主进程）；
//   - Electron 依赖全注入（createRealCuaCursorHud 拿真 BrowserWindow，
//     测试拿 fake——与 drag panel 同模式）。
// 坐标系：macOS 全局点（CGEvent）与 Electron DIP 在 macOS 上 1:1。

import { createSocket, type Socket } from "node:dgram";
import type { BrowserWindow } from "electron";

/** UDP 端口：与 node-repl-host 注入的 ZCODE_CUA_CURSOR_BROADCAST_PORT 对齐。 */
export const CUA_CURSOR_HUD_UDP_PORT = 53717;
/** 会话静默自动隐藏（ms）。 */
export const CUA_CURSOR_HUD_IDLE_HIDE_MS = 6_000;
/** 光标窗尺寸（DIP）：光标图 48×48 + 变换余量。 */
export const CUA_CURSOR_WINDOW_SIZE = { width: 120, height: 120 };

export interface CuaCursorEventFrame {
  v: number;
  kind: "point" | "down" | "up" | "drag_start" | "drag_end" | "key" | "text";
  x?: number;
  y?: number;
  detail?: string;
}

export interface CuaCursorHudWindowLike {
  setPosition(x: number, y: number): void;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  showInactive(): void;
  hide(): void;
  close(): void;
  isVisible(): boolean;
  isDestroyed(): boolean;
  once(event: "closed", listener: () => void): void;
  webContents: {
    send(channel: string, ...args: unknown[]): void;
    once(event: "ready-to-show", listener: () => void): void;
  };
}

export interface CuaCursorHudDeps {
  BrowserWindow: typeof BrowserWindow;
  screen: {
    getPrimaryDisplay(): { workArea: { x: number; y: number; width: number; height: number } };
  };
  createUdpListener?: (port: number, onFrame: (frame: CuaCursorEventFrame) => void) => { close(): void };
}

/** 帧解析：坏帧（非对象/版本不符/未知 kind）→ undefined。 */
export function parseCursorEventFrame(raw: string): CuaCursorEventFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const frame = parsed as Record<string, unknown>;
  if (frame.v !== 1) return undefined;
  const kind = frame.kind;
  if (
    kind !== "point" &&
    kind !== "down" &&
    kind !== "up" &&
    kind !== "drag_start" &&
    kind !== "drag_end" &&
    kind !== "key" &&
    kind !== "text"
  ) {
    return undefined;
  }
  const result: CuaCursorEventFrame = { v: 1, kind };
  if (typeof frame.x === "number" && Number.isFinite(frame.x)) result.x = frame.x;
  if (typeof frame.y === "number" && Number.isFinite(frame.y)) result.y = frame.y;
  if (typeof frame.detail === "string") result.detail = frame.detail;
  return result;
}

/** 事件 → 光标窗左上角坐标（热点偏移 4,4）。无坐标事件返回 undefined。 */
export function cursorWindowPositionFor(frame: CuaCursorEventFrame): { x: number; y: number } | undefined {
  if (frame.x === undefined || frame.y === undefined) return undefined;
  return { x: Math.round(frame.x) - 4, y: Math.round(frame.y) - 4 };
}

function cursorWindowHtml(): string {
  // 纯静态页（data:URL 无 nodeIntegration）：特效由 main 侧 executeJavaScript 调
  // 全局函数驱动（__cuaDown/__cuaUp）——第一步无动画，位移由 setPosition 完成。
  const svg = `<svg width="48" height="48" viewBox="0 0 48 48" style="position:absolute;left:36px;top:36px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))"><path d="M6 2 L6 40 L15 31 L21 45 L27 42 L21 29 L34 28 Z" fill="#1f2937" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden;user-select:none}
    #cursor{position:relative;width:120px;height:120px;will-change:transform;transition:transform .09s cubic-bezier(.2,.9,.3,1.2)}
    #cursor.down{transform:scale(.84)}
    #pulse{position:absolute;left:28px;top:28px;width:20px;height:20px;border-radius:50%;
      background:rgba(51,156,255,.55);opacity:0;transform:scale(.4)}
    #pulse.fire{animation:pulse .45s ease-out}
    @keyframes pulse{0%{opacity:.9;transform:scale(.4)}100%{opacity:0;transform:scale(2.6)}}
  </style></head><body><div id="cursor">${svg}<div id="pulse"></div></div>
  <script>
    window.__cuaDown = function () { document.getElementById("cursor").classList.add("down"); };
    window.__cuaUp = function () {
      var cursor = document.getElementById("cursor");
      cursor.classList.remove("down");
      var pulse = document.getElementById("pulse");
      pulse.classList.remove("fire"); void pulse.offsetWidth; pulse.classList.add("fire");
    };
  <\/script></body></html>`;
}

function bannerWindowHtml(workArea: { width: number }): string {
  const width = Math.min(560, Math.max(360, Math.round(workArea * 0.5)));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    #banner{margin:10px auto;width:${width - 20}px;height:36px;border-radius:18px;
      background:linear-gradient(135deg,rgba(51,156,255,.95),rgba(28,120,220,.95));
      color:#fff;font:500 13px -apple-system,"SF Pro Text",system-ui,sans-serif;
      display:flex;align-items:center;justify-content:center;gap:8px;
      box-shadow:0 4px 16px rgba(15,80,160,.35);-webkit-font-smoothing:antialiased}
    .dot{width:8px;height:8px;border-radius:50%;background:#fff;animation:blink 1.2s infinite}
    @keyframes blink{0%,100%{opacity:.35}50%{opacity:1}}
  </style></head><body><div id="banner"><span class="dot"></span>FreeCodeZ 正在使用你的电脑 · 停止任务可取消</div></body></html>`;
}

/**
 * HUD 控制器：惰性建窗、事件驱动、空闲隐藏。
 * 返回 dispose（关窗+关监听）。UDP listener 由 deps 注入（真实现绑 dgram）。
 */
export function createCuaCursorHud(deps: CuaCursorHudDeps) {
  let cursorWindow: CuaCursorHudWindowLike | undefined;
  let bannerWindow: CuaCursorHudWindowLike | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let disposed = false;

  const hideAll = () => {
    if (cursorWindow && !cursorWindow.isDestroyed() && cursorWindow.isVisible()) cursorWindow.hide();
    if (bannerWindow && !bannerWindow.isDestroyed() && bannerWindow.isVisible()) bannerWindow.hide();
  };

  const scheduleIdleHide = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!disposed) hideAll();
    }, CUA_CURSOR_HUD_IDLE_HIDE_MS);
    idleTimer.unref?.();
  };

  const makeOverlayWindowOptions = () =>
    ({
      // macOS: panel + focusable:false —— HUD 不抢焦点不激活 app（drag panel 同论证）。
      type: "panel",
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        // 纯静态 data:URL 页 + executeJavaScript 驱动：不需要 node 面板（默认沙箱）。
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    }) as ConstructorParameters<typeof BrowserWindow>[0];

  const ensureCursorWindow = () => {
    if (cursorWindow && !cursorWindow.isDestroyed()) return cursorWindow;
    const win = new deps.BrowserWindow({
      ...makeOverlayWindowOptions(),
      width: CUA_CURSOR_WINDOW_SIZE.width,
      height: CUA_CURSOR_WINDOW_SIZE.height,
      x: -1000,
      y: -1000,
    });
    // click-through：HUD 永不吞输入。
    (win as unknown as { setIgnoreMouseEvents: (v: boolean) => void }).setIgnoreMouseEvents(true);
    (win as unknown as { setAlwaysOnTop: (v: boolean, level?: string) => void }).setAlwaysOnTop(
      true,
      "screen-saver",
    );
    void (win as unknown as { loadURL: (url: string) => Promise<void> }).loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(cursorWindowHtml())}`,
    );
    win.once("closed", () => {
      cursorWindow = undefined;
    });
    cursorWindow = win as unknown as CuaCursorHudWindowLike;
    return cursorWindow;
  };

  const ensureBannerWindow = () => {
    if (bannerWindow && !bannerWindow.isDestroyed()) return bannerWindow;
    const workArea = deps.screen.getPrimaryDisplay().workArea;
    const width = Math.min(560, Math.max(380, Math.round(workArea.width * 0.5)));
    const win = new deps.BrowserWindow({
      ...makeOverlayWindowOptions(),
      width,
      height: 58,
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: workArea.y + 4,
    });
    (win as unknown as { setIgnoreMouseEvents: (v: boolean) => void }).setIgnoreMouseEvents(true);
    (win as unknown as { setAlwaysOnTop: (v: boolean, level?: string) => void }).setAlwaysOnTop(
      true,
      "screen-saver",
    );
    void (win as unknown as { loadURL: (url: string) => Promise<void> }).loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(bannerWindowHtml({ width: workArea.width }))}`,
    );
    win.once("closed", () => {
      bannerWindow = undefined;
    });
    bannerWindow = win as unknown as CuaCursorHudWindowLike;
    return bannerWindow;
  };

  const handleFrame = (frame: CuaCursorEventFrame) => {
    if (disposed) return;
    const cursor = ensureCursorWindow();
    ensureBannerWindow();
    const position = cursorWindowPositionFor(frame);
    if (position) cursor.setPosition(position.x, position.y);
    // 特效（data:URL 无 ipc）：main 侧调用页面全局函数；失败静默（窗口未就绪竞态）。
    const effect =
      frame.kind === "down" || frame.kind === "drag_start"
        ? "__cuaDown()"
        : frame.kind === "up" || frame.kind === "drag_end"
          ? "__cuaUp()"
          : undefined;
    if (effect) {
      void (cursor.webContents as unknown as {
        executeJavaScript: (code: string) => Promise<unknown>;
      })
        .executeJavaScript(effect)
        .catch(() => undefined);
    }
    if (!cursor.isVisible()) cursor.showInactive();
    if (bannerWindow && !bannerWindow.isDestroyed() && !bannerWindow.isVisible()) {
      bannerWindow.showInactive();
    }
    scheduleIdleHide();
  };

  const createUdpListener =
    deps.createUdpListener ??
    ((_port: number, onFrame: (frame: CuaCursorEventFrame) => void) => {
      // 真 dgram 监听（main 进程侧；desktop 打包环境 node 内建可用）。
      const socket: Socket = createSocket("udp4");
      socket.on("message", (message: Buffer) => {
        const frame = parseCursorEventFrame(message.toString("utf8"));
        if (frame) onFrame(frame);
      });
      socket.on("error", () => {
        // 端口占用等：HUD 静默退位（可视化缺席不影响控制本体）。
      });
      socket.bind(_port, "127.0.0.1");
      return {
        close() {
          try {
            socket.close();
          } catch {
            // 双 close 防御。
          }
        },
      };
    });

  const listener = createUdpListener(CUA_CURSOR_HUD_UDP_PORT, handleFrame);

  return {
    /** 测试/手动驱动口（UDP 之外的直接注入）。 */
    handleFrame,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (idleTimer) clearTimeout(idleTimer);
      listener.close();
      for (const win of [cursorWindow, bannerWindow]) {
        if (win && !win.isDestroyed()) win.close();
      }
      cursorWindow = undefined;
      bannerWindow = undefined;
    },
  };
}

export type CuaCursorHud = ReturnType<typeof createCuaCursorHud>;
