export interface KoffiCursorEvent {
  v: number;
  kind: "point" | "down" | "up" | "drag_start" | "drag_end" | "key" | "text";
  x?: number;
  y?: number;
  detail?: string;
}

export function createKoffiBrokerMethods(options?: {
  allowActions?: boolean;
  onInputEvent?: (event: KoffiCursorEvent) => void;
}): {
  methods: Record<string, (params: unknown, context?: unknown) => Promise<unknown>>;
  dispose: () => void;
  allowActions: boolean;
} | null;
export function loadKoffiBindings(): Record<string, unknown> | null;
export function probePermissionsInProcess(): { accessibility: boolean; screenCapture: boolean; koffiAvailable: boolean };
export function cursorEventsForClick(input: { x: number; y: number; button?: string }): KoffiCursorEvent[];
export function cursorEventsForDrag(input: { fromX: number; fromY: number; toX: number; toY: number }): KoffiCursorEvent[];
export function cursorEventsForKey(input: { key?: string }): KoffiCursorEvent[];
export function cursorEventsForText(input: { text?: string }): KoffiCursorEvent[];
export function emitCursorEvents(onInputEvent: ((event: KoffiCursorEvent) => void) | null, events: KoffiCursorEvent[]): void;
export const CURSOR_EVENT_WIRE_VERSION: 1;
export const CURSOR_HOTSPOT: { x: number; y: number };
