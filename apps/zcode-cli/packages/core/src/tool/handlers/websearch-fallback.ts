// ============================================================
// WebSearch 客户端回退链(P6 §3.2 v1.1 修正)
// 端点无原生搜索时:Brave → Exa → Linkup(按已配置 key 串行降级)。
// 与 image_search 共享 key 解析与 SQLite 缓存(search-shared)。
// ============================================================

import type { WebSearchOutput, WebSearchResultItem, WebSearchSource } from "@zcode/contracts";
import { dedupeByNormalizedUrl, fetchJsonWithTimeout, getSearchCache, resolveSearchProviderKeys } from "./search-shared.js";

const WEB_CACHE_TTL_MS = 10 * 60 * 1000;

interface FallbackResult {
  output: WebSearchOutput;
  provider: string;
}

export interface WebSearchFallbackDeps {
  query: string;
  abortSignal?: AbortSignal;
  startedAt: number;
}

/**
 * 执行客户端搜索回退链。无可用 key 时返回 null(调用方转配置引导错误)。
 */
export async function runWebSearchFallback(deps: WebSearchFallbackDeps): Promise<FallbackResult | null> {
  const keys = await resolveSearchProviderKeys(process.env);
  const cache = getSearchCache("web-search");
  const cacheKey = JSON.stringify(deps.query);

  const cached = cache.get<WebSearchOutput>(cacheKey);
  if (cached) {
    return { output: { ...cached, meta: undefined, ...cached } as WebSearchOutput, provider: "cache" };
  }

  const chain: Array<[string, () => Promise<WebSearchResultItem[]>]> = [];
  if (keys.brave) {
    chain.push(["brave", () => fetchBraveWeb(deps.query, keys.brave!, deps.abortSignal)]);
  }
  if (keys.exa) {
    chain.push(["exa", () => fetchExa(deps.query, keys.exa!, deps.abortSignal)]);
  }
  if (keys.linkup) {
    chain.push(["linkup", () => fetchLinkup(deps.query, keys.linkup!, deps.abortSignal)]);
  }
  if (chain.length === 0) return null;

  let lastError: unknown;
  for (const [provider, run] of chain) {
    try {
      const items = dedupeByNormalizedUrl(await run()).slice(0, 10);
      const output = buildFallbackOutput(deps.query, items, deps.startedAt, provider);
      cache.put(cacheKey, output, WEB_CACHE_TTL_MS);
      return { output, provider };
    } catch (error) {
      lastError = error;
      // 链上失败继续降级。
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function buildFallbackOutput(
  query: string,
  items: WebSearchResultItem[],
  startedAt: number,
  provider: string,
): WebSearchOutput {
  const sources: WebSearchSource[] = items.map((item) => ({
    ...(item.title ? { title: item.title } : {}),
    url: item.url,
  }));
  return {
    query,
    results: items.map((item) => ({
      ...(item.title ? { title: item.title } : {}),
      url: item.url,
    })),
    sources,
    durationMs: Date.now() - startedAt,
    // 回退链无服务端 summary(规格书 P6 §3.2 已知缺陷);模型侧自行读结果。
  } as WebSearchOutput;
}

async function fetchBraveWeb(query: string, apiKey: string, signal?: AbortSignal): Promise<WebSearchResultItem[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "10");
  const payload = (await fetchJsonWithTimeout(url.toString(), {
    headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
    signal,
  })) as { web?: { results?: Array<Record<string, unknown>> } };
  return (payload.web?.results ?? []).map((entry) => ({
    title: typeof entry.title === "string" ? entry.title : undefined,
    url: String(entry.url ?? ""),
  })).filter((item) => item.url.length > 0);
}

async function fetchExa(query: string, apiKey: string, signal?: AbortSignal): Promise<WebSearchResultItem[]> {
  const payload = (await fetchJsonWithTimeout("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query, numResults: 10, type: "keyword" }),
    signal,
  })) as { results?: Array<Record<string, unknown>> };
  return (payload.results ?? []).map((entry) => ({
    title: typeof entry.title === "string" ? entry.title : undefined,
    url: String(entry.url ?? ""),
  })).filter((item) => item.url.length > 0);
}

async function fetchLinkup(query: string, apiKey: string, signal?: AbortSignal): Promise<WebSearchResultItem[]> {
  const payload = (await fetchJsonWithTimeout("https://api.linkup.ai/v1/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, depth: "standard" }),
    signal,
  })) as { results?: Array<Record<string, unknown>> };
  return (payload.results ?? []).map((entry) => ({
    title: typeof entry.name === "string" ? entry.name : undefined,
    url: String(entry.url ?? ""),
  })).filter((item) => item.url.length > 0);
}
