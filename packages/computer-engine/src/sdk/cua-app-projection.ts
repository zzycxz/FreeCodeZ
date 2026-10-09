// FreeCodeZ W-30：cuaApp 身份投影（FC 自有件）。G.1：SDK 缓存最近 listApps 快照供
// cuaApp 投影；语义自旧 cua-app-snapshot.ts（W-06 删除，历史 5b61071^）平移：
// pid 精确命中优先；无 pid 按 bundleId 唯一匹配（同 bundle 多进程不猜测）。
// 输出形状对齐 S6 契约（rows.cuaAppIdentitySchema：pid/name/bundleId）。
export interface CuaAppIdentity {
  pid: number;
  name: string;
  bundleId?: string;
}

export interface ListAppsEntry {
  pid?: number | null;
  name?: string | null;
  bundleId?: string | null;
}

/** listApps 结果 → 身份快照（按 pid 建索引）。 */
export function buildCuaAppSnapshot(entries: readonly ListAppsEntry[]): Map<number, CuaAppIdentity> {
  const snapshot = new Map<number, CuaAppIdentity>();
  for (const entry of entries) {
    if (typeof entry.pid !== "number" || !Number.isInteger(entry.pid) || entry.pid <= 0) continue;
    if (typeof entry.name !== "string" || !entry.name.trim()) continue;
    snapshot.set(entry.pid, {
      pid: entry.pid,
      name: entry.name,
      ...(entry.bundleId ? { bundleId: entry.bundleId } : {}),
    });
  }
  return snapshot;
}

/** 动作输入里的 app_ref 解析（pid 或 bundleId；输入形状兼容 app_ref/app/target.app_ref）。 */
export function resolveCuaAppIdentity(
  input: unknown,
  snapshot: ReadonlyMap<number, CuaAppIdentity>,
): CuaAppIdentity | undefined {
  const pid = readInputPid(input);
  if (pid !== null) return snapshot.get(pid);
  const bundleId = readInputBundleId(input);
  if (!bundleId) return undefined;
  const matches = [...snapshot.values()].filter((app) => app.bundleId === bundleId);
  // 同一 bundle 可能存在多个进程；没有 PID 时不能猜测具体进程身份。
  return matches.length === 1 ? matches[0] : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asAppRef(value: unknown): Record<string, unknown> | null {
  return asRecord(value);
}

function readInputPid(input: unknown): number | null {
  const root = asRecord(input);
  const candidates = [root?.app_ref, root?.app, asRecord(root?.target)?.app_ref];
  for (const candidate of candidates) {
    const pid = asAppRef(candidate)?.pid;
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

function readInputBundleId(input: unknown): string | null {
  const root = asRecord(input);
  const candidates = [root?.app_ref, root?.app, asRecord(root?.target)?.app_ref];
  for (const candidate of candidates) {
    const bundleId = asAppRef(candidate)?.bundleId;
    if (typeof bundleId === "string" && bundleId.trim()) return bundleId.trim();
  }
  return null;
}
