// ============================================================
// WebSearch 客户端回退链(P6 §3.2 v1.1 修正 + §4.1 摘要层接线)
// 端点无原生搜索时:Brave → Exa → Linkup(按已配置 key 串行降级)。
// 与 image_search 共享 key 解析与 SQLite 缓存(search-shared)。
//
// FreeCodeZ fork(P6 §4.1):summaryMode=on/vlm 时对 top-5 结果做一次嵌套
// 辅助模型请求生成综合摘要,模型上下文形态对齐原生路径(websearch-results.ts
// 的 "Summary + ≤20 links" 紧凑格式),主模型不必逐条抓页——这是套餐版
// 服务端 summary 的客户端等价物。off 时零额外模型调用。
// ============================================================

import {
  runWithModelInvocationContext,
  type WebSearchOutput,
  type WebSearchResultItem,
  type WebSearchSource,
} from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import { auxiliaryModelOptions } from "../../model/auxiliary-model-options.js";
import {
  dedupeByNormalizedUrl,
  fetchJsonWithTimeout,
  getSearchCache,
  resolveSearchProviderKeys,
} from "./search-shared.js";

const WEB_CACHE_TTL_MS = 10 * 60 * 1000;
const FALLBACK_RESULT_LIMIT = 10;
const SUMMARY_INPUT_RESULTS = 5;

interface FallbackResult {
  output: WebSearchOutput;
  provider: string;
}

export interface WebSearchFallbackDeps {
  query: string;
  abortSignal?: AbortSignal;
  startedAt: number;
  /** P6 §6.2:safeSearch/country 由会话偏好透传;仅 Brave web 源支持这两个参数。 */
  safeSearch?: "off" | "moderate" | "strict";
  country?: string;
  /**
   * 摘要层模型(会话模型)。summaryMode=off 时调用方不传——回退链自身不读
   * 偏好,开关决策收口在 websearch.ts,便于单测与避免双处判断。
   */
  summaryModel?: NonNullable<ToolExecutionContext["model"]>;
  traceContext?: ToolExecutionContext["traceContext"];
  traceId?: ToolExecutionContext["traceId"];
  sessionId?: ToolExecutionContext["sessionId"];
  turnId?: ToolExecutionContext["turnId"];
}

/**
 * 执行客户端搜索回退链。无可用 key 时返回 null(调用方转配置引导错误)。
 */
export async function runWebSearchFallback(
  deps: WebSearchFallbackDeps,
): Promise<FallbackResult | null> {
  const keys = await resolveSearchProviderKeys(process.env);
  const cache = getSearchCache("web-search");
  // safeSearch/country/摘要开关影响输出,必须进缓存键,否则改设置后 TTL 内回旧结果。
  const cacheKey = JSON.stringify([
    deps.query,
    deps.safeSearch ?? "moderate",
    deps.country ?? "",
    deps.summaryModel ? "summary" : "plain",
  ]);

  const cached = cache.get<WebSearchOutput>(cacheKey);
  if (cached) {
    return { output: cached, provider: "cache" };
  }

  const chain: Array<[string, () => Promise<WebSearchResultItem[]>]> = [];
  if (keys.brave) {
    chain.push([
      "brave",
      () =>
        fetchBraveWeb(
          deps.query,
          keys.brave!,
          { safeSearch: deps.safeSearch, country: deps.country },
          deps.abortSignal,
        ),
    ]);
  }
  if (keys.exa) {
    chain.push(["exa", () => fetchExa(deps.query, keys.exa!, deps.abortSignal)]);
  }
  if (keys.linkup) {
    chain.push(["linkup", () => fetchLinkup(deps.query, keys.linkup!, deps.abortSignal)]);
  }
  // AnySearch 零 key 尾链(2026-09-23,用户拍板):实测匿名可用(带无效 key 反而 401),
  // 固定垫底——有 key 带 Bearer 归属配额,无 key 匿名,零配置下搜索不再全挂。
  chain.push(["anysearch", () => fetchAnySearch(deps.query, keys.anysearch, deps.abortSignal)]);
  if (chain.length === 0) return null;

  let lastError: unknown;
  for (const [provider, run] of chain) {
    try {
      const items = dedupeByNormalizedUrl(await run()).slice(0, FALLBACK_RESULT_LIMIT);
      const summary = deps.summaryModel
        ? await generateFallbackSummary(deps, items, deps.summaryModel)
        : undefined;
      const output = buildFallbackOutput(deps.query, items, deps.startedAt, provider, summary);
      cache.put(cacheKey, output, WEB_CACHE_TTL_MS);
      return { output, provider };
    } catch (error) {
      lastError = error;
      // 链上失败继续降级。摘要失败不拖垮搜索:generateFallbackSummary 内部已兜错返回 undefined。
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function buildFallbackOutput(
  query: string,
  items: WebSearchResultItem[],
  startedAt: number,
  provider: string,
  summary?: string,
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
    ...(summary ? { summary } : {}),
    durationMs: Date.now() - startedAt,
  } as WebSearchOutput;
}

/**
 * 摘要层(P6 §4.1):对 top-N 结果做一次嵌套辅助请求。失败返回 undefined,
 * 搜索结果本身不受影响——摘要是增益,不是依赖。
 */
async function generateFallbackSummary(
  deps: WebSearchFallbackDeps,
  items: WebSearchResultItem[],
  model: NonNullable<ToolExecutionContext["model"]>,
): Promise<string | undefined> {
  if (items.length === 0) return undefined;
  const links = items
    .slice(0, SUMMARY_INPUT_RESULTS)
    .map((item) => `- ${item.title ?? item.url}\n  ${item.url}`)
    .join("\n");
  try {
    const metadata: Record<string, unknown> = { operation: "web_search_summary" };
    if (deps.traceId) metadata.traceId = deps.traceId;
    if (deps.sessionId) metadata.sessionId = deps.sessionId;
    if (deps.turnId) metadata.turnId = deps.turnId;
    const events = runWithModelInvocationContext(
      {
        ...(deps.traceContext ? { traceContext: deps.traceContext } : {}),
        metadata,
        modelRequestSessionType: "other",
        modelCall: { operation: "web_search" },
      },
      () =>
        model.streamText({
          messages: [
            {
              role: "system",
              content:
                "You summarize web search results. Write one compact paragraph (max ~120 words) "
                + "in the query's language, covering the key findings across the listed results. "
                + "Reply with the summary paragraph only.",
            },
            {
              role: "user",
              content: `Search query: ${deps.query}\n\nResults:\n${links}`,
            },
          ],
          options: {
            ...auxiliaryModelOptions(model),
            maxOutputTokens: Math.min(1024, model.optionSpecs.maxOutputTokens.max),
          },
          abortSignal: deps.abortSignal,
        }),
    );
    let text = "";
    for await (const event of events) {
      if (event.type === "text_delta") text += event.text;
      if (event.type === "error") return undefined;
    }
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

async function fetchBraveWeb(
  query: string,
  apiKey: string,
  regional: { safeSearch?: "off" | "moderate" | "strict"; country?: string },
  signal?: AbortSignal,
): Promise<WebSearchResultItem[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "10");
  // P6 §6.2:safeSearch/country 偏好仅在源支持时下发(Exa/Linkup 无对应参数)。
  if (regional.safeSearch) url.searchParams.set("safesearch", regional.safeSearch);
  if (regional.country) url.searchParams.set("country", regional.country);
  const payload = (await fetchJsonWithTimeout(url.toString(), {
    headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
    ...(signal ? { signal } : {}),
  })) as { web?: { results?: Array<Record<string, unknown>> } };
  return (payload.web?.results ?? [])
    .map((entry) => ({
      title: typeof entry.title === "string" ? entry.title : undefined,
      url: String(entry.url ?? ""),
    }))
    .filter((item) => item.url.length > 0);
}

async function fetchExa(
  query: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<WebSearchResultItem[]> {
  const payload = (await fetchJsonWithTimeout("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query, numResults: 10, type: "keyword" }),
    ...(signal ? { signal } : {}),
  })) as { results?: Array<Record<string, unknown>> };
  return (payload.results ?? [])
    .map((entry) => ({
      title: typeof entry.title === "string" ? entry.title : undefined,
      url: String(entry.url ?? ""),
    }))
    .filter((item) => item.url.length > 0);
}

// 修复(2026-09-23):原端点误写 api.linkup.ai——该域是域名停放页(NS=afternic.com,
// 任意子域都解析到停放 IP,443 握手即被拒),后端无 API,请求从未到达 Linkup;
// body 误写 {query, depth} 也会被真实 API 判 400(要求 q + outputType)。
// 正确契约对齐 fairpeer websearch.go searchLinkup:POST api.linkup.so/v1/search,
// body {q, depth, outputType:"searchResults"},响应 {results:[{name,url,content}]}。
export async function fetchLinkup(
  query: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<WebSearchResultItem[]> {
  const payload = (await fetchJsonWithTimeout("https://api.linkup.so/v1/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, depth: "standard", outputType: "searchResults" }),
    ...(signal ? { signal } : {}),
  })) as { results?: Array<Record<string, unknown>> };
  return (payload.results ?? [])
    .map((entry) => ({
      title: typeof entry.name === "string" ? entry.name : undefined,
      url: String(entry.url ?? ""),
    }))
    .filter((item) => item.url.length > 0);
}

/**
 * AnySearch 尾链(对齐 fairpeer websearch.go 的请求契约):
 * POST https://api.anysearch.com/v1/search,响应 {code,message,
 * data:{results:[{title,url,snippet,content}]}};code!=0 视为失败继续降级。
 * key 可选:零 key 匿名尾链(2026-09-23)——匿名可用,带无效 key 反而 401。
 */
export async function fetchAnySearch(
  query: string,
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<WebSearchResultItem[]> {
  const payload = (await fetchJsonWithTimeout("https://api.anysearch.com/v1/search", {
    method: "POST",
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, max_results: 10 }),
    ...(signal ? { signal } : {}),
  })) as {
    code?: number;
    message?: string;
    data?: { results?: Array<Record<string, unknown>> };
  };
  if (typeof payload.code === "number" && payload.code !== 0) {
    throw new Error(`anysearch error: ${payload.message ?? String(payload.code)}`);
  }
  return (payload.data?.results ?? [])
    .map((entry) => ({
      title: typeof entry.title === "string" ? entry.title : undefined,
      url: String(entry.url ?? ""),
    }))
    .filter((item) => item.url.length > 0);
}
