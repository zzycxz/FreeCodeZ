import type { McpToolDescriptor } from "@zcode/contracts";

/**
 * 进程内 tools/list 目录缓存（spec mcp-availability-first-cost-management 规则 2.5）。
 *
 * 作用点只有一个：`listTools()` 对仍处 connecting 的 server 并入缓存工具，
 * 让冷启动/慢速远程 MCP 的工具在连接完成前即可装配（codex Catalog readiness 同义）。
 * 缓存**不影响可见性**——命中期间照常全量注入，连接完成后 record.tools 自然接管。
 * 不落盘：跨版本 schema/描述符形态可能漂移，进程内 TTL 足够覆盖冷启动窗口。
 *
 * 失效三路：TTL 过期、`tools/list_changed` 通知（manager 显式 invalidate）、
 * 连接字段变化（fingerprint 不匹配即不命中）。
 */

const DEFAULT_CAPACITY = 16;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

export interface ToolCatalogCacheEntry {
  tools: McpToolDescriptor[];
  /** 连接相关配置指纹（disabledTools 豁免后序列化）；配置变了缓存即失效。 */
  connectionFingerprint: string;
  storedAt: number;
}

export interface ToolCatalogCacheClock {
  now(): number;
}

export class McpToolCatalogCache {
  private readonly entries = new Map<string, ToolCatalogCacheEntry>();
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly clock: ToolCatalogCacheClock;

  constructor(options: { capacity?: number; ttlMs?: number; clock?: ToolCatalogCacheClock } = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  get(
    serverName: string,
    connectionFingerprint: string,
  ): ToolCatalogCacheEntry | undefined {
    const entry = this.entries.get(serverName);
    if (!entry) return undefined;
    if (entry.connectionFingerprint !== connectionFingerprint) {
      this.entries.delete(serverName);
      return undefined;
    }
    if (this.clock.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(serverName);
      return undefined;
    }
    // LRU 触碰：移到末尾。
    this.entries.delete(serverName);
    this.entries.set(serverName, entry);
    return entry;
  }

  set(serverName: string, entry: ToolCatalogCacheEntry): void {
    this.entries.delete(serverName);
    this.entries.set(serverName, entry);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  invalidate(serverName: string): void {
    this.entries.delete(serverName);
  }
}

/** 连接相关配置指纹：与收敛相等性同口径，disabledTools 变化不失效缓存。 */
export function toolCatalogConnectionFingerprint(config: unknown): string {
  if (typeof config !== "object" || config === null) return "null";
  const { disabledTools: _disabledTools, ...rest } = config as Record<string, unknown>;
  try {
    return JSON.stringify(rest) ?? "null";
  } catch {
    return "null";
  }
}
