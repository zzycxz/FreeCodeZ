// FreeCodeZ 类型壳（配对 index.js，W-14 桥）。
export interface EngineSdkOptions {
  transport: { request(method: string, params?: Record<string, unknown>): Promise<unknown> };
  sessionId: string;
  /** G3（2026-10-11 装机审计）：app-instructions 资产根，透传 ComputerUseSdkOptions.docsRoot。 */
  docsRoot?: string;
}
export declare function createEngineSdk(options: EngineSdkOptions): Promise<unknown>;
export interface SidecarHarnessOptions {
  sidecarPath: string;
  env?: Record<string, string>;
}
export interface SidecarHarness {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  stop(): Promise<void>;
}
export declare function createSidecarHarness(options: SidecarHarnessOptions): Promise<SidecarHarness>;
