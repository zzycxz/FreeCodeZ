// ============================================================
// CUA 光标 HUD：帧 wire 契约 + 常量（自 cuaCursorHud.ts 拆出——max-lines 400 门，
// 拆分先例同 koffi-diagnostics/koffi-tree；语义零变化）
// ============================================================
// 帧来源：新引擎桥层 cursor-events 发射面（SDK 动作旁路，UDP 广播）。

/** UDP 端口：与 desktop 主进程注入的 FREECODEZ_CUA_CURSOR_BROADCAST_PORT 对齐（node-repl-host 读侧双读旧键）。 */
export const CUA_CURSOR_HUD_UDP_PORT = 53717;
/** 会话静默自动隐藏（ms）。 */
export const CUA_CURSOR_HUD_IDLE_HIDE_MS = 6_000;
/** loading 透镜自熄（ms）：末次 text 帧后无后续输入帧即熄灭（打字间隙感）。 */
export const CUA_LENS_AUTO_OFF_MS = 1_200;
/** 光标窗尺寸（DIP）：光标图 48×48 + 变换余量。 */
export const CUA_CURSOR_WINDOW_SIZE = { width: 120, height: 120 };

export interface CuaCursorEventFrame {
  v: number;
  kind: "point" | "down" | "up" | "drag_start" | "drag_end" | "key" | "text";
  x?: number;
  y?: number;
  detail?: string;
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
