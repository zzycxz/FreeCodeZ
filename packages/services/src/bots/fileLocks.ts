// bots-runtime-locks 文件锁租约（附录B §7）：多窗口互斥渠道 runtime。
// 布局：`<configDir>/bots-runtime-locks/<kind>/<sha256(token.trim()).hex>.lock/`；
// 内容：owner.json {"pid","botId","nonce","createdAt"} + lease-<nonce>（mtime=租约时间戳）；
// 获取：staging `<lock>.<nonce>.pending/` 写两文件 → rename 原子生效；冲突时读 owner 判活/判租约，
// 过期则 rm -rf（重试 [100,250,500]ms）再来一轮（≤2 轮）；心跳 10s utimes；释放要求 owner 三元组全匹配。
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export type BotRuntimeLockKind =
  | "telegram-polling"
  | "weixin-polling"
  | "feishu-websocket"
  | "lark-websocket";

export const BOT_RUNTIME_LOCK_KINDS: readonly BotRuntimeLockKind[] = [
  "telegram-polling",
  "weixin-polling",
  "feishu-websocket",
  "lark-websocket",
];

const LOCK_ROOT_DIR = "bots-runtime-locks";
const LOCK_HEARTBEAT_MS = 10_000;
const LOCK_LEASE_TTL_MS = 30_000;
const CLEANUP_RETRY_DELAYS_MS = [100, 250, 500] as const;
const RENAME_CONFLICT_CODES = new Set(["EEXIST", "ENOTEMPTY", "EISDIR", "EPERM"]);

interface BotRuntimeLockOwner {
  pid: number;
  botId: string;
  nonce: string;
  createdAt: number;
}

export interface BotRuntimeLease {
  kind: BotRuntimeLockKind;
  botId: string;
  /** sha256(token.trim()).hex，用于诊断与指纹比较。 */
  tokenHash: string;
  nonce: string;
  release(): Promise<void>;
}

export interface AcquireBotRuntimeLockParams {
  configDir: string;
  kind: BotRuntimeLockKind;
  /** telegram/weixin 为 bot token；feishu/lark 为 feishuAppId.trim()。 */
  token: string;
  botId: string;
  pid?: number;
  now?: () => number;
}

export function hashBotRuntimeLockToken(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex");
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** kill(pid, 0) 探活：EPERM（无权限但存在）按存活处理。 */
export function isLockOwnerProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return getErrorCode(error) === "EPERM";
  }
}

async function readLockOwner(lockPath: string): Promise<BotRuntimeLockOwner | null> {
  try {
    const raw = await readFile(join(lockPath, "owner.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as BotRuntimeLockOwner).pid === "number" &&
      typeof (parsed as BotRuntimeLockOwner).botId === "string" &&
      typeof (parsed as BotRuntimeLockOwner).nonce === "string"
    ) {
      return parsed as BotRuntimeLockOwner;
    }
    return null;
  } catch {
    return null;
  }
}

async function readLeaseMtimeMs(lockPath: string, nonce: string): Promise<number | null> {
  try {
    const info = await stat(join(lockPath, `lease-${nonce}`));
    return info.mtimeMs;
  } catch {
    return null;
  }
}

async function removeLockDir(lockPath: string): Promise<void> {
  for (const delay of [...CLEANUP_RETRY_DELAYS_MS, 0]) {
    try {
      await rm(lockPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (delay === 0) throw error;
      await sleep(delay);
    }
  }
}

/** 冲突锁是否仍被活进程持有（pid 存活且租约 mtime 在 30s 内）。 */
async function isForeignLockHeld(lockPath: string, nowMs: number): Promise<boolean> {
  const owner = await readLockOwner(lockPath);
  if (!owner) return true; // 无法判定时保守视为他窗持有，避免抢占写了一半的锁
  if (!isLockOwnerProcessAlive(owner.pid)) return false;
  const leaseMtime = await readLeaseMtimeMs(lockPath, owner.nonce);
  if (leaseMtime === null) return false;
  return nowMs - leaseMtime < LOCK_LEASE_TTL_MS;
}

async function tryCreateLock(
  lockPath: string,
  owner: BotRuntimeLockOwner,
): Promise<boolean> {
  const stagingPath = `${lockPath}.${owner.nonce}.pending`;
  await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(stagingPath, { recursive: true });
  try {
    await writeFile(join(stagingPath, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
    await writeFile(join(stagingPath, `lease-${owner.nonce}`), "", "utf8");
    await rename(stagingPath, lockPath);
    return true;
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    if (RENAME_CONFLICT_CODES.has(getErrorCode(error) ?? "")) return false;
    throw error;
  }
}

/**
 * 获取渠道 runtime 锁；≤2 轮。他窗持锁返回 null（调用方按 HandledElsewhere 处理）。
 * 轮内：staging rename 原子互斥；失败读 owner 判活，过期则清理后重来。
 */
export async function acquireBotRuntimeLock(
  params: AcquireBotRuntimeLockParams,
): Promise<BotRuntimeLease | null> {
  const nowMs = (params.now ?? Date.now)();
  const tokenHash = hashBotRuntimeLockToken(params.token);
  const lockPath = join(params.configDir, LOCK_ROOT_DIR, params.kind, `${tokenHash}.lock`);
  await mkdir(join(params.configDir, LOCK_ROOT_DIR, params.kind), { recursive: true });

  for (let round = 0; round < 2; round += 1) {
    const nonce = randomBytes(8).toString("hex");
    const owner: BotRuntimeLockOwner = {
      pid: params.pid ?? process.pid,
      botId: params.botId,
      nonce,
      createdAt: nowMs,
    };
    if (await tryCreateLock(lockPath, owner)) {
      const leaseFile = join(lockPath, `lease-${nonce}`);
      const heartbeat = setInterval(() => {
        const stamp = new Date();
        utimes(leaseFile, stamp, stamp).catch(() => undefined);
      }, LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      let released = false;
      return {
        kind: params.kind,
        botId: params.botId,
        tokenHash,
        nonce,
        release: async () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          // owner 三元组（pid+botId+nonce）全匹配才删目录，避免误删后入主者的锁
          const current = await readLockOwner(lockPath);
          if (
            !current ||
            current.pid !== owner.pid ||
            current.botId !== owner.botId ||
            current.nonce !== owner.nonce
          ) {
            return;
          }
          await removeLockDir(lockPath).catch(() => undefined);
        },
      };
    }
    if (await isForeignLockHeld(lockPath, nowMs)) return null;
    await removeLockDir(lockPath).catch(() => undefined);
  }
  return null;
}
