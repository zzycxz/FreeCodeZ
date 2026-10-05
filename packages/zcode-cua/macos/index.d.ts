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

export interface AppshotWindowInfo {
  windowId: number;
  pid: number;
  layer: number;
  ownerName?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}
export function pickFrontmostAppWindow(
  windows: AppshotWindowInfo[],
  options?: { excludePids?: number[]; minSize?: { width: number; height: number } },
): AppshotWindowInfo | undefined;
export function appshotSnapshot(options?: {
  excludePids?: number[];
  readWindows?: () => AppshotWindowInfo[];
  capture?: (windowId: number) => Promise<{ ok: true; path: string; bytes: number } | { ok: false; error: { code: string; message: string } }>;
}): Promise<
  | {
      ok: true;
      app: { pid: number; name: string };
      windowId: number;
      bounds?: { x: number; y: number; width: number; height: number };
      capture?: { path: string; bytes: number };
      captureError?: { code: string; message: string };
      axTree: { elementCount: number; note?: string };
      note?: string;
    }
  | { ok: false; error: { code: string; message: string } }
>;
export function nextDoubleTapState(
  state: { phase: string; lastReleaseAt?: number; lastTriggerAt?: number } | undefined,
  isDown: boolean,
  now: number,
  options?: { windowMs?: number; refractoryMs?: number },
): { state: { phase: string; lastReleaseAt?: number; lastTriggerAt?: number }; triggered: boolean };
export function createModifierDoubleTapWatcher(options: {
  modifier: "cmd" | "alt" | "shift";
  onTrigger: () => void;
  intervalMs?: number;
  platform?: string;
  loadBindings?: () => unknown;
}): { stop(): void; available: boolean };

export interface CursorVec2 { x: number; y: number }
export interface CursorMotionState { position: CursorVec2; velocity: CursorVec2 }
export function primarySpringResponse(distancePt: number): number;
export function cursorMotionStep(state: CursorMotionState, target: CursorVec2, distanceHintPt: number, dt: number): CursorMotionState;
export function isCloseEnough(position: CursorVec2, target: CursorVec2): boolean;
export function bezierPathCandidates(from: CursorVec2, to: CursorVec2): CursorVec2[][];
export function scootTransform(from: CursorVec2, to: CursorVec2): { rotationDeg: number; scaleX: number; scaleY: number };
export function clickTransform(): { rotationDeg: number };
export function clamp(value: number, min: number, max: number): number;
export const PRIMARY_SPRING_DAMPING: number;
export const SCOOT_THRESHOLD_PT: number;
export const SCOOT_RESPONSE: number;
export const SCOOT_DAMPING: number;
export const SCOOT_STRETCH: { horizontal: number; vertical: number };
export const SCOOT_MAX_ROTATION_DEG: number;
export const CLICK_ANGLE_DEG: number;
export const BEZIER_PARAMS: { startHandle: number; endHandle: number; arcHeight: number; arcBias: number; candidates: number };
export const STRAIGHT_LINE_THRESHOLD_PT: number;
export const CLOSE_ENOUGH_PT: number;
export const STRETCH_PIVOT_X: number;
