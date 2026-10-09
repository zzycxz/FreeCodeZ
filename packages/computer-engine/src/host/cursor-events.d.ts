// FreeCodeZ 类型壳（配对 cursor-events.js，FC 原创件平移）。
export declare const CURSOR_EVENT_WIRE_VERSION: number;
export declare const CURSOR_HOTSPOT: { x: number; y: number };
export interface CursorHudEvent {
  v: number;
  kind: "point" | "down" | "up" | "drag_start" | "drag_end" | "key" | "text";
  x?: number;
  y?: number;
  detail?: string;
}
export declare function cursorEventsForClick(input: {
  x?: number;
  y?: number;
  button?: string;
}): CursorHudEvent[];
export declare function cursorEventsForDrag(input: {
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
}): CursorHudEvent[];
export declare function cursorEventsForKey(input: { key?: string | number }): CursorHudEvent[];
export declare function cursorEventsForText(input: { text?: string }): CursorHudEvent[];
export declare function emitCursorEvents(
  onInputEvent: ((event: CursorHudEvent) => void) | undefined,
  events: CursorHudEvent[],
): void;
