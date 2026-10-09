// FreeCodeZ 类型壳（配对 cua-runtime/index.js，FC 原创件平移）。
export declare function loadKoffiBindings(): unknown;
export declare function probePermissionsInProcess(): {
  accessibility: boolean;
  screenCapture: boolean;
};
export declare function requestScreenCaptureAccessInProcess(): { granted: boolean };
export declare function requestAccessibilityAccessInProcess(): void;
export declare function appshotSnapshot(...args: unknown[]): any;
export declare function captureWindowPng(...args: unknown[]): any;
export declare function pickFrontmostAppWindow(...args: unknown[]): any;
export declare function buildOnScreenWindowsReader(...args: unknown[]): any;
export declare const FRONTMOST_MIN_WINDOW_SIZE: { width: number; height: number };
export declare function createModifierDoubleTapWatcher(...args: unknown[]): any;
export declare function nextDoubleTapState(...args: unknown[]): any;
export declare const MODIFIER_KEY_CODES: Record<string, number>;
export declare const DOUBLE_TAP_WINDOW_MS: number;
