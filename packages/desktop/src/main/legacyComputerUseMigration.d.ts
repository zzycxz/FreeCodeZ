// FreeCodeZ 类型壳（配对 legacyComputerUseMigration.js，W-32 FC 原创件）。
export interface LegacyMigrationAction {
  kind: "remove-dir" | "remove-dir-glob" | "tccutil-reset" | "warn-env" | "report-only";
  label: string;
  path?: string;
  root?: string;
  namePrefix?: string;
  service?: string;
  bundleId?: string;
  keys?: string[];
}
export declare function planLegacyComputerUseMigration(input?: Record<string, unknown>): LegacyMigrationAction[];
export declare function runLegacyComputerUseMigration(
  actions: LegacyMigrationAction[],
  options?: { log?: (message: string) => void },
): Array<LegacyMigrationAction & { result: string; error?: string }>;
