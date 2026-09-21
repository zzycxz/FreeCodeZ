// ============================================================
// ImageSearch Tool(P6 §3.4):三源降级链 + 归一化层 + SQLite 缓存
// SerpAPI(google_images, 缓存命中免费) → Brave Images(订阅) →
// Openverse(零 key, 仅 CC 池, 显式标注)。
// ============================================================

import {
  CoreErrorType,
  IMAGE_SEARCH_TOOL_CONTRACT,
  ImageSearchInputJsonSchema,
  ImageSearchInputSchema,
  ImageSearchOutputJsonSchema,
  ImageSearchOutputSchema,
  createCoreError,
  type ImageResultItem,
  type ImageSearchInput,
  type ImageSearchOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import {
  dedupeByNormalizedUrl,
  fetchJsonWithTimeout,
  getSearchCache,
  resolveSearchProviderKeys,
} from "./search-shared.js";

const IMAGE_SEARCH_TOOL_NAME = "ImageSearch";
const DEFAULT_PAGE_SIZE = 10;
const IMAGE_CACHE_TTL_MS = 45 * 60 * 1000;

// -----------------------------------------------
// 源适配器(规格书 P6 §4.3:禁止透传源生格式,统一归一化)
// -----------------------------------------------

interface RawImageResult {
  title?: unknown;
  originalUrl?: unknown;
  thumbnailUrl?: unknown;
  pageUrl?: unknown;
  width?: unknown;
  height?: unknown;
  source?: unknown;
  license?: unknown;
  attribution?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

interface UrlLikeForDedupe {
  url: string;
}

function toDedupeList(items: readonly ImageResultItem[]): UrlLikeForDedupe[] {
  return items.map((item) => ({ url: item.originalUrl, item }));
}

function dedupeItems(items: readonly ImageResultItem[]): ImageResultItem[] {
  const wrapped = dedupeByNormalizedUrl(toDedupeList(items));
  return wrapped.map((entry) => (entry as { url: string; item: ImageResultItem }).item);
}

function normalizeItems(provider: string, raw: readonly RawImageResult[]): ImageResultItem[] {
  const items: ImageResultItem[] = [];
  for (const entry of raw) {
    const originalUrl = asString(entry.originalUrl);
    if (!originalUrl) continue;
    items.push({
      kind: "image",
      title: asString(entry.title) ?? "",
      originalUrl,
      ...(asString(entry.thumbnailUrl) ? { thumbnailUrl: asString(entry.thumbnailUrl) } : {}),
      ...(asString(entry.pageUrl) ? { pageUrl: asString(entry.pageUrl) } : {}),
      width: asPositiveInt(entry.width) ?? null,
      height: asPositiveInt(entry.height) ?? null,
      ...(asString(entry.source) ? { source: asString(entry.source) } : {}),
      provider,
      ...(asString(entry.license) ? { license: asString(entry.license) } : {}),
      ...(asString(entry.attribution) ? { attribution: asString(entry.attribution) } : {}),
    });
  }
  return items;
}

async function fetchSerpapiGoogleImages(
  query: string,
  apiKey: string,
  page: number,
  pageSize: number,
): Promise<ImageResultItem[]> {
  const start = (page - 1) * pageSize;
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_images");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("num", String(pageSize));
  if (start > 0) url.searchParams.set("start", String(start));
  const payload = (await fetchJsonWithTimeout(url.toString())) as {
    images_results?: Array<Record<string, unknown>>;
  };
  const raw = (payload.images_results ?? []).map((entry) => ({
    title: entry.title,
    originalUrl: entry.original,
    thumbnailUrl: entry.thumbnail,
    pageUrl: entry.link ?? entry.source,
    width: entry.original_width,
    height: entry.original_height,
    source: entry.source,
  }));
  return normalizeItems("serpapi", raw);
}

async function fetchBraveImages(
  query: string,
  apiKey: string,
  _page: number,
  pageSize: number,
): Promise<ImageResultItem[]> {
  // Brave Images 不分页无 offset(规格书 P6 附录 A):固定 hasMore=false 由调用方标注。
  const url = new URL("https://api.search.brave.com/res/v1/images/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(pageSize));
  const payload = (await fetchJsonWithTimeout(url.toString(), {
    headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
  })) as { results?: Array<Record<string, unknown>> };
  const raw = (payload.results ?? []).map((entry) => ({
    title: entry.title,
    originalUrl: entry.url ?? entry.image,
    thumbnailUrl:
      typeof entry.thumbnail === "object" && entry.thumbnail !== null
        ? ((entry.thumbnail as { src?: unknown }).src as string | undefined) ?? undefined
        : (entry.thumbnail as string | undefined),
    pageUrl: entry.source ?? entry.url,
    width:
      typeof entry.properties === "object" && entry.properties !== null
        ? (entry.properties as { width?: unknown }).width
        : undefined,
    height:
      typeof entry.properties === "object" && entry.properties !== null
        ? (entry.properties as { height?: unknown }).height
        : undefined,
    source: entry.source ? new URL(String(entry.source)).hostname : undefined,
  }));
  return normalizeItems("brave", raw);
}

interface OpenverseResponse {
  results?: Array<Record<string, unknown>>;
  page_count?: number;
}

async function fetchOpenverseImages(
  query: string,
  page: number,
  pageSize: number,
): Promise<ImageResultItem[]> {
  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", query);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(pageSize));
  const payload = (await fetchJsonWithTimeout(url.toString(), {
    headers: { "User-Agent": "FreeCodeZ-ImageSearch/1.0" },
  })) as OpenverseResponse;
  const raw = (payload.results ?? []).map((entry) => ({
    title: entry.title,
    originalUrl: entry.url,
    thumbnailUrl: entry.thumbnail,
    pageUrl: entry.foreign_landing_url,
    width: entry.width,
    height: entry.height,
    source: entry.source,
    license: [entry.license, entry.license_version].filter(Boolean).join("-") || undefined,
    attribution: entry.attribution,
  }));
  return normalizeItems("openverse", raw);
}

// -----------------------------------------------
// Handler
// -----------------------------------------------

const imageSearchHandler: ToolHandler<ImageSearchInput, ImageSearchOutput> = async (
  input,
  context,
) => {
  const startedAt = Date.now();
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const cache = getSearchCache("image-search");
  const cacheKey = JSON.stringify([input.query, page, pageSize, input.license ?? "any"]);

  const cached = cache.get<ImageSearchOutput>(cacheKey);
  if (cached) {
    return { ...cached, meta: { ...cached.meta, cacheHit: true, requestMs: 0 } };
  }

  const keys = await resolveSearchProviderKeys(process.env);

  // license=cc 直跳 Openverse(规格书 P6 §6.1)。
  if (input.license === "cc") {
    const output = await runOpenverse(input.query, page, pageSize, startedAt, false);
    cache.put(cacheKey, output, IMAGE_CACHE_TTL_MS);
    return output;
  }

  // 降级链:SerpAPI → Brave → Openverse(零 key 尾)。
  if (keys.serpapi) {
    try {
      const output = await buildEnvelope(
        input.query,
        await fetchSerpapiGoogleImages(input.query, keys.serpapi, page, pageSize),
        page,
        pageSize,
        startedAt,
        { provider: "serpapi", degradedFrom: null, hasMore: true },
      );
      cache.put(cacheKey, output, IMAGE_CACHE_TTL_MS);
      return output;
    } catch (error) {
      // 降级静默:链上失败由 meta.degradedFrom 观测。
    }
  }
  if (keys.brave) {
    try {
      const output = await buildEnvelope(
        input.query,
        await fetchBraveImages(input.query, keys.brave, page, pageSize),
        page,
        pageSize,
        startedAt,
        { provider: "brave", degradedFrom: keys.serpapi ? "serpapi" : null, hasMore: false },
      );
      cache.put(cacheKey, output, IMAGE_CACHE_TTL_MS);
      return output;
    } catch (error) {
      // 降级静默:链上失败由 meta.degradedFrom 观测。
    }
  }

  const output = await runOpenverse(
    input.query,
    page,
    pageSize,
    startedAt,
    keys.serpapi || keys.brave ? true : false,
  );
  cache.put(cacheKey, output, IMAGE_CACHE_TTL_MS);
  return output;

  async function runOpenverse(
    query: string,
    page: number,
    pageSize: number,
    startedAt: number,
    degraded: boolean,
  ): Promise<ImageSearchOutput> {
    try {
      const items = await fetchOpenverseImages(query, page, pageSize);
      return await buildEnvelope(query, items, page, pageSize, startedAt, {
        provider: "openverse",
        degradedFrom: degraded ? "commercial-chain" : null,
        hasMore: items.length >= pageSize,
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 429) {
        // 限速容错(规格书 P6 §8.10):明确错误与升级指引,不静默空结果。
        throw createCoreError(
          CoreErrorType.ToolExecutionFailed,
          "Openverse rate limit reached (20/min anonymous, 200/day). "
            + "Register a free Openverse API key or configure a commercial search key "
            + "(SERPAPI_API_KEY / BRAVE_API_KEY or the search:serpapi / search:brave credential).",
          { context: { toolName: IMAGE_SEARCH_TOOL_NAME, query }, recoverable: true },
        );
      }
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        `Image search failed: ${error instanceof Error ? error.message : String(error)}`,
        { context: { toolName: IMAGE_SEARCH_TOOL_NAME, query }, recoverable: true },
      );
    }
  }
};

async function buildEnvelope(
  query: string,
  items: ImageResultItem[],
  page: number,
  pageSize: number,
  startedAt: number,
  meta: {
    provider: string;
    degradedFrom: string | null;
    hasMore: boolean;
  },
): Promise<ImageSearchOutput> {
  // 去重:URL 规范化 + tracking 参数剥离(规格书 P6 §4.3 第 3 条)。
  const deduped = dedupeItems(items).slice(0, pageSize);
  return {
    query,
    results: deduped,
    meta: {
      provider: meta.provider,
      ...(meta.degradedFrom ? { degradedFrom: meta.degradedFrom } : {}),
      cacheHit: false,
      requestMs: Date.now() - startedAt,
      page,
      pageSize,
      hasMore: meta.hasMore && deduped.length >= pageSize,
    },
  };
}

function formatImageSearchModelContent(output: ImageSearchOutput): string {
  const lines: string[] = [];
  const ccOnly = output.meta.provider === "openverse";
  lines.push(
    `Image search results for "${output.query}" (provider: ${output.meta.provider}`
      + (ccOnly ? "; Openverse contains only CC-licensed content" : "")
      + ")",
  );
  for (const item of output.results) {
    const dims = item.width && item.height ? ` ${item.width}x${item.height}` : "";
    const license = item.license ? ` [${item.license}]` : "";
    lines.push(
      `- ${item.title || "(untitled)"}${dims}${license}: ${item.originalUrl}`
        + (item.pageUrl ? ` (source: ${item.pageUrl})` : ""),
    );
  }
  if (ccOnly && output.results.length > 0) {
    lines.push("Note: results come from the Openverse CC-only pool; content scope differs from web-wide image search.");
  }
  return lines.join("\n");
}

export const imageSearchToolEntry: ToolEntry = {
  ...IMAGE_SEARCH_TOOL_CONTRACT,
  metadata: {
    name: IMAGE_SEARCH_TOOL_NAME,
    description:
      "Search the web for images. Providers: SerpAPI (Google Images) → Brave Images → Openverse "
        + "(zero-key fallback, CC-licensed content only). Use license='cc' to restrict to openly "
        + "licensed images. Results include original URL, dimensions, source page and license "
        + "when available.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30_000,
    maxOutputBytes: 24_000,
    sideEffectScope: "network",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: imageSearchHandler as ToolHandler,
  formatModelContent: (output: unknown) =>
    formatImageSearchModelContent(ImageSearchOutputSchema.parse(output)),
  inputSchema: ImageSearchInputJsonSchema,
  outputSchema: ImageSearchOutputJsonSchema,
  runtimeInputSchema: ImageSearchInputSchema,
  runtimeOutputSchema: ImageSearchOutputSchema,
};
