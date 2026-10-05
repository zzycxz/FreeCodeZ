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
