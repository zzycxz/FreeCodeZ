// FreeCodeZ 类型壳（配对 cursor-animation.js，FC 原创件平移）。
export declare const USER_MOUSE_ACTIVITY_THRESHOLD_MS: number;
export declare const PRIMARY_SPRING_DAMPING: number;
export declare const SCOOT_THRESHOLD_PT: number;
export declare const SCOOT_RESPONSE: number;
export declare const SCOOT_DAMPING: number;
export declare const SCOOT_STRETCH: { horizontal: number; vertical: number };
export declare const SCOOT_MAX_ROTATION_DEG: number;
export declare const CLICK_ANGLE_DEG: number;
export declare const BEZIER_PARAMS: {
  startHandle: number;
  endHandle: number;
  arcHeight: number;
  arcBias: number;
  candidates: number;
};
export declare const STRAIGHT_LINE_THRESHOLD_PT: number;
export declare const CLOSE_ENOUGH_PT: number;
export declare const STRETCH_PIVOT_X: number;

export interface Vec2 {
  x: number;
  y: number;
}
export interface CursorMotionState {
  position: Vec2;
  velocity: Vec2;
}
export interface UserMouseActivityReading {
  userActive: boolean;
  lastMoveMs: number | undefined;
}

export declare function primarySpringResponse(distancePt: number): number;
export declare function clamp(value: number, min: number, max: number): number;
export declare function springStep(
  position: number,
  velocity: number,
  target: number,
  response: number,
  damping: number,
  dt: number,
): { position: number; velocity: number };
export declare function cursorMotionStep(
  state: CursorMotionState,
  target: Vec2,
  distanceHintPt: number,
  dt: number,
): CursorMotionState;
export declare function isCloseEnough(position: Vec2, target: Vec2): boolean;
export declare function bezierPathCandidates(from: Vec2, to: Vec2): Vec2[][];
export declare function scootTransform(
  from: Vec2,
  to: Vec2,
): { rotationDeg: number; scaleX: number; scaleY: number };
export declare function clickTransform(): { rotationDeg: number };
export declare function readUserMouseActivity(bindings: unknown): UserMouseActivityReading;
export declare function nextInterventionState(
  state: "idle" | "paused" | undefined,
  userActive: boolean,
  resumeIntent: boolean,
): "idle" | "paused";
