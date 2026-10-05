// ============================================================
// Phase 2-1a：输入事件表（升级实施手册 桌面控制 Phase 2 第一步）
// ============================================================
// 纯函数：动作参数 → HUD 光标事件序列。执行层（koffi-broker-methods）在真实合成
// 输入前后按序发射；HUD 侧只消费事件流画光标（move 到位 → down/up 脉冲）。
// 抽纯函数的原因：事件序列是 HUD 契约，测试钉死它而无需真实移动系统鼠标。
//
// 事件形状（wire 稳定，UDP JSON 单帧 ≤512B）：
//   { v: 1, kind: "point"|"down"|"up"|"drag_start"|"drag_end"|"key"|"text", x?, y?, detail? }
// 坐标：macOS 全局屏幕点（与 CGEvent 同一坐标系；Electron DIP 1:1）。

export const CURSOR_EVENT_WIRE_VERSION = 1;

/** 光标热点（光标图左上角到指针尖的偏移，pt）——与素材 hotspot(4,4) 对齐。 */
export const CURSOR_HOTSPOT = { x: 4, y: 4 };

export function cursorEventsForClick(input) {
  const x = Number(input?.x);
  const y = Number(input?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
  return [
    { v: CURSOR_EVENT_WIRE_VERSION, kind: "point", x, y },
    { v: CURSOR_EVENT_WIRE_VERSION, kind: "down", x, y, detail: input?.button ?? "left" },
    { v: CURSOR_EVENT_WIRE_VERSION, kind: "up", x, y, detail: input?.button ?? "left" },
  ];
}

export function cursorEventsForDrag(input) {
  const events = [];
  const fromX = Number(input?.fromX);
  const fromY = Number(input?.fromY);
  const toX = Number(input?.toX);
  const toY = Number(input?.toY);
  if ([fromX, fromY, toX, toY].every(Number.isFinite)) {
    events.push({ v: CURSOR_EVENT_WIRE_VERSION, kind: "drag_start", x: fromX, y: fromY });
    // 中途两点：HUD 第一步无动画，但路径存在性让 HUD 可画轨迹残影（后续步骤用）。
    events.push({ v: CURSOR_EVENT_WIRE_VERSION, kind: "point", x: (fromX + toX) / 2, y: (fromY + toY) / 2 });
    events.push({ v: CURSOR_EVENT_WIRE_VERSION, kind: "drag_end", x: toX, y: toY });
  }
  return events;
}

export function cursorEventsForKey(input) {
  return [
    {
      v: CURSOR_EVENT_WIRE_VERSION,
      kind: "key",
      ...(input?.key !== undefined ? { detail: String(input.key) } : {}),
    },
  ];
}

export function cursorEventsForText(input) {
  const text = typeof input?.text === "string" ? input.text : "";
  if (!text) return [];
  return [
    {
      v: CURSOR_EVENT_WIRE_VERSION,
      kind: "text",
      detail: text.length > 40 ? `${text.slice(0, 40)}…` : text,
    },
  ];
}

/** 事件发射器：options.onInputEvent 在场时逐个回调，异常吞掉（HUD 是旁路可视化，不折断动作）。 */
export function emitCursorEvents(onInputEvent, events) {
  if (typeof onInputEvent !== "function" || !Array.isArray(events)) return;
  for (const event of events) {
    try {
      onInputEvent(event);
    } catch {
      // 可视化旁路：发射失败绝不影响输入合成本体。
    }
  }
}
