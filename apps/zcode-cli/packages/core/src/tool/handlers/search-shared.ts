// ============================================================
// 搜索基础设施共享层(P6)
// key 解析(credential store 加密 + env 兜底)、URL 规范化去重、
// SQLite 持久缓存(node:sqlite,复用 agent 既有栈)。
// ============================================================

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SearchProviderKeys {
  serpapi?: string;
  brave?: string;
  exa?: string;
  linkup?: string;
}

const CREDENTIAL_KEYS: Record<keyof SearchProviderKeys, string> = {
  serpapi: "search:serpapi",
  brave: "search:brave",
  exa: "search:exa",
  linkup: "search:linkup",
};

const ENV_KEYS: Record<keyof SearchProviderKeys, string> = {
  serpapi: "SERPAPI_API_KEY",
  brave: "BRAVE_API_KEY",
  exa: "EXA_API_KEY",
  linkup: "LINKUP_API_KEY",
};

/**
 * 解析搜索 key:优先加密凭据仓库(credentials.json, enc: 前缀加密),
 * env 直填为开发/CI 兜底。两处都空 → 该源不可用,降级链自动跳过。
 */
export async function resolveSearchProviderKeys(env: NodeJS.ProcessEnv): Promise<SearchProviderKeys> {
  const keys: SearchProviderKeys = {};
  const names = Object.keys(CREDENTIAL_KEYS) as Array<keyof SearchProviderKeys>;
  let credentialLoad:
    | ((keys: readonly string[]) => Promise<Record<string, string | null>>)
    | undefined;
  try {
    const { createSharedZCodeCredentialStore } = await import(
      "@zcode/adapters/auth"
    );
    const store = createSharedZCodeCredentialStore({ env });
    credentialLoad = (wanted) => store.loadMany(wanted);
  } catch {
    // 独立环境(纯 CLI 无凭据仓库)仅 env。
  }
  const wanted = names.map((n) => CREDENTIAL_KEYS[n]);
  const stored = (await credentialLoad?.(wanted)) ?? {};
  for (const name of names) {
    const fromStore = stored[CREDENTIAL_KEYS[name]]?.trim();
    const fromEnv = env[ENV_KEYS[name]]?.trim();
    const value = fromStore || fromEnv || undefined;
    if (value) keys[name] = value;
  }
  return keys;
}

// -----------------------------------------------
// URL 规范化与去重(规格书 P6 §4.3)
// -----------------------------------------------

const TRACKING_PARAM_PREFIXES = ["utm_", "ga_", "fbclid", "gclid", "mc_", "ref_"] as const;

export function normalizeUrlForDedupe(raw: string): string | null {
  try {
    const url = new URL(raw);
    url.hash = "";
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    const params = [...url.searchParams.entries()].filter(
      ([key]) => !TRACKING_PARAM_PREFIXES.some((p) => key.toLowerCase().startsWith(p)),
    );
    url.search = "";
    for (const [key, value] of params) url.searchParams.append(key, value);
    // 尾斜杠挂在 pathname 上剥离(带查询串时 URL 末尾不是 "/")。
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function dedupeByNormalizedUrl<T extends { url: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = normalizeUrlForDedupe(item.url) ?? item.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// -----------------------------------------------
// SQLite 持久缓存(规格书 P6 §6.3)
// 独立 cache/search-cache.sqlite;可丢弃,不并入 session-store 迁移体系。
// -----------------------------------------------

export interface SearchCacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class SearchSqliteCache {
  readonly #db: DatabaseSync | null;
  readonly #ns: string;

  constructor(namespace: string, dbPath?: string) {
    this.#ns = namespace;
    const storageRoot =
      dbPath ??
      process.env.ZCODE_STORAGE_DIR?.trim() ??
      join(homedir(), ".freecodez");
    try {
      mkdirSync(join(storageRoot, "cache"), { recursive: true });
      this.#db = new DatabaseSync(join(storageRoot, "cache", "search-cache.sqlite"));
      this.#db.exec(
        "CREATE TABLE IF NOT EXISTS search_cache (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (ns, key))",
      );
    } catch {
      // 只读文件系统/受限环境:缓存降级为不缓存,搜索仍可用。
      this.#db = null;
    }
  }

  get<T>(key: string): T | undefined {
    if (!this.#db) return undefined;
    try {
      const row = this.#db
        .prepare("SELECT value, expires_at FROM search_cache WHERE ns = ? AND key = ?")
        .get(this.#ns, key) as { value: string; expires_at: number } | undefined;
      if (!row) return undefined;
      if (row.expires_at <= Date.now()) {
        this.#db.prepare("DELETE FROM search_cache WHERE ns = ? AND key = ?").run(this.#ns, key);
        return undefined;
      }
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  put(key: string, value: unknown, ttlMs: number): void {
    if (!this.#db) return;
    try {
      this.#db
        .prepare(
          "INSERT OR REPLACE INTO search_cache (ns, key, value, expires_at) VALUES (?, ?, ?, ?)",
        )
        .run(this.#ns, key, JSON.stringify(value), Date.now() + ttlMs);
    } catch {
      // 缓存写入失败不影响搜索路径。
    }
  }

  close(): void {
    try {
      this.#db?.close();
    } catch {
      // 忽略。
    }
  }
}

// 进程级单例(工具句柄每次调用共享同一 sqlite 连接)。
const cacheSingletons = new Map<string, SearchSqliteCache>();

export function getSearchCache(namespace: string): SearchSqliteCache {
  let cache = cacheSingletons.get(namespace);
  if (!cache) {
    cache = new SearchSqliteCache(namespace);
    cacheSingletons.set(namespace, cache);
  }
  return cache;
}

// -----------------------------------------------
// 共享 HTTP fetch(带超时与响应体上限)
// -----------------------------------------------

export async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<unknown> {
  const { timeoutMs = 15_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...rest, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`) as Error & {
        status?: number;
      };
      error.status = response.status;
      throw error;
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}
