// FreeCodeZ 类型壳（配对 index.js，W-14 桥）。
export interface EngineSdkOptions {
  transport: { request(method: string, params?: Record<string, unknown>): Promise<unknown> };
  sessionId: string;
  /** G3（2026-10-11 装机审计）：app-instructions 资产根，透传 ComputerUseSdkOptions.docsRoot。 */
  docsRoot?: string;
  /** V1.19 P1：动作层设置门（cuaActionsEnabled）。false=动作面拒 actions_disabled、
   * 观测面豁免；透传 ComputerUseSdkOptions.actionsEnabled。 */
  actionsEnabled?: boolean;
  /** V1.19 P3：光标 HUD 帧出口（W-28 cursor-events 发射面）。透传
   * ComputerUseSdkOptions.onInputEvent。 */
  onInputEvent?: (event: unknown) => void;
  /** V1.19 P4（W-30/S6 重建）：观测目标应用身份上报（真实快照解析）。透传
   * ComputerUseSdkOptions.onCuaApp。 */
  onCuaApp?: (app: { pid: number; name: string; bundleId?: string }) => void;
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
