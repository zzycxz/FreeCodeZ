// FreeCodeZ 类型壳（配对 engine-bridge.js，W-19）。
export declare function getComputerUsePermissionStatus(): Promise<{
  platform: string;
  permissions: Array<{ id: string; status: string }>;
  helperUnavailableReason?: string | null;
}>;
export declare function openComputerUsePermissions(permission?: string): Promise<unknown>;
export declare function resetComputerUsePermissions(): Promise<unknown>;
