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
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";
import {
  dedupeByNormalizedUrl,
  fetchJsonWithTimeout,
  getSearchCache,
  resolveSearchProviderKeys,
} from "./search-shared.js";

const IMAGE_SEARCH_TOOL_NAME = "ImageSearch";
const DEFAULT_PAGE_SIZE = 10;
const IMAGE_CACHE_TTL_MS = 45 * 60 * 1000;

/**
 * safeSearch/country → 各源参数映射(P6 §6.2 接线;纯函数可单测)。
 * SerpAPI 只有 active/off 两档;Openverse 两参数均不支持(调用方不传)。
 */
export type SearchSafeSearch = "off" | "moderate" | "strict";

export function serpapiSafeSearchParam(safeSearch: SearchSafeSearch): "active" | "off" {
  return safeSearch === "off" ? "off" : "active";
}

interface RegionalSearchParams {
  safeSearch: SearchSafeSearch;
  country?: string;
}

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

/**
 * 源字段容错取主机名:完整 URL 取 hostname,裸主机名原样,垃圾丢弃,永不抛错。
 * 修复(2026-09-23):Brave Images 的 source 曾有裸主机名形态,原实现直接
 * new URL() 会抛 Invalid URL,把整次调用拖进降级。
 */
function hostnameFromUrlLike(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  try {
    return new URL(text).hostname;
  } catch {
    return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?$/i.test(text) ? text : undefined;
  }
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

export async function fetchSerpapiGoogleImages(
  query: string,
  apiKey: string,
  page: number,
  pageSize: number,
  regional: RegionalSearchParams,
): Promise<ImageResultItem[]> {
  const start = (page - 1) * pageSize;
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_images");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("num", String(pageSize));
  url.searchParams.set("safe", serpapiSafeSearchParam(regional.safeSearch));
  if (regional.country) url.searchParams.set("gl", regional.country);
  if (start > 0) url.searchParams.set("start", String(start));
  const payload = (await fetchJsonWithTimeout(url.toString())) as {
    error?: unknown;
    images_results?: Array<Record<string, unknown>>;
  };
  // 修复(2026-09-23):SerpAPI 对无 key/配额尽等错误返回 HTTP 200 + {error} 而非
  // 4xx,只看 response.ok 会把错误 JSON 当成 images_results 缺失的空结果静默吞掉,
  // 链失去降级机会。识别 error 字段即抛错走降级。
  const errorText = asString(payload.error);
  if (errorText) throw new Error(`serpapi error: ${errorText}`);
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

export async function fetchBraveImages(
  query: string,
  apiKey: string,
  _page: number,
  pageSize: number,
  regional: RegionalSearchParams,
): Promise<ImageResultItem[]> {
  // Brave Images 不分页无 offset(规格书 P6 附录 A):固定 hasMore=false 由调用方标注。
  const url = new URL("https://api.search.brave.com/res/v1/images/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(pageSize));
  url.searchParams.set("safesearch", regional.safeSearch);
  if (regional.country) url.searchParams.set("country", regional.country);
  const payload = (await fetchJsonWithTimeout(url.toString(), {
    headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
  })) as { results?: Array<Record<string, unknown>> };
  // 解析容错(2026-09-23,契约未实测属防御性修复):原图字段在不同 API 版本可能
  // 位于 properties.url 或顶层 url/image,逐级回退;source 是完整 URL 时才当页面
  // 链接用,裸主机名只进 source 展示(见 hostnameFromUrlLike)。
  const raw = (payload.results ?? []).map((entry) => {
    const properties =
      typeof entry.properties === "object" && entry.properties !== null
        ? (entry.properties as Record<string, unknown>)
        : undefined;
    const sourceText = asString(entry.source);
    const sourceIsPageUrl = /^https?:\/\//i.test(sourceText ?? "");
    return {
      title: entry.title,
      originalUrl: asString(properties?.url) ?? entry.url ?? entry.image,
      thumbnailUrl:
        typeof entry.thumbnail === "object" && entry.thumbnail !== null
          ? ((entry.thumbnail as { src?: unknown }).src as string | undefined) ?? undefined
          : (entry.thumbnail as string | undefined),
      pageUrl: sourceIsPageUrl ? sourceText : entry.url,
      width: properties?.width,
      height: properties?.height,
      source: hostnameFromUrlLike(entry.source),
    };
  });
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
  // FreeCodeZ fork(P6 §6.2):safeSearch/country/summaryMode 来自会话偏好;缺席取协议默认。
  const prefs = context.searchVision;
  const regional: RegionalSearchParams = {
    safeSearch: prefs?.safeSearch ?? "moderate",
    ...(prefs?.country ? { country: prefs.country } : {}),
  };
  const summaryMode = prefs?.summaryMode ?? "on";
  const cache = getSearchCache("image-search");
  // 偏好影响请求参数与 caption 生成,必须进缓存键,否则改设置后 45 分钟内回旧结果。
  const cacheKey = JSON.stringify([
    input.query,
    page,
    pageSize,
    input.license ?? "any",
    regional.safeSearch,
    regional.country ?? "",
    summaryMode,
  ]);

  const cached = cache.get<ImageSearchOutput>(cacheKey);
  if (cached) {
    return { ...cached, meta: { ...cached.meta, cacheHit: true, requestMs: 0 } };
  }

  const keys = await resolveSearchProviderKeys(process.env);

  // license=cc 直跳 Openverse(规格书 P6 §6.1)。
  if (input.license === "cc") {
    const output = await finalizeOutput(
      await runOpenverse(input.query, page, pageSize, regional, startedAt, false),
      context,
      summaryMode,
    );
    cache.put(cacheKey, output, IMAGE_CACHE_TTL_MS);
    return output;
  }

  // 降级链:SerpAPI → Brave → Openverse(零 key 尾)。
  if (keys.serpapi) {
    try {
      const output = await finalizeOutput(
        await buildEnvelope(
          input.query,
          await fetchSerpapiGoogleImages(input.query, keys.serpapi, page, pageSize, regional),
          page,
          pageSize,
          startedAt,
          { provider: "serpapi", degradedFrom: null, hasMore: true },
        ),
        context,
        summaryMode,
      );
      cache.put(cacheKey, output, IMAGE_CACHE_TTL_MS);
      return output;
    } catch (error) {
      // 降级静默:链上失败由 meta.degradedFrom 观测。
    }
  }
  if (keys.brave) {
    try {
      const output = await finalizeOutput(
        await buildEnvelope(
          input.query,
          await fetchBraveImages(input.query, keys.brave, page, pageSize, regional),
          page,
          pageSize,
          startedAt,
          { provider: "brave", degradedFrom: keys.serpapi ? "serpapi" : null, hasMore: false },
        ),
        context,
        summaryMode,
      );
      cache.put(cacheKey, output, IMAGE_CACHE_TTL_MS);
      return output;
    } catch (error) {
      // 降级静默:链上失败由 meta.degradedFrom 观测。
    }
  }

  const output = await finalizeOutput(
    await runOpenverse(
      input.query,
      page,
      pageSize,
      regional,
      startedAt,
      keys.serpapi || keys.brave ? true : false,
    ),
    context,
    summaryMode,
  );
  cache.put(cacheKey, output, IMAGE_CACHE_TTL_MS);
  return output;

  async function runOpenverse(
    query: string,
    page: number,
    pageSize: number,
    regional: RegionalSearchParams,
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

// -----------------------------------------------
// vlm caption 层(P6 §4.1:summary=vlm 时对 top-3 缩略图经视觉模型生成一句话描述)
// 对齐套餐版 image_search 的服务端 caption 语义:信息密度高于 title,主模型
// 不必逐条抓来源页。视觉模型缺席时降级为无 caption(spec §4.3),不额外报错。
// -----------------------------------------------

const VLM_CAPTION_MAX_RESULTS = 3;
const VLM_CAPTION_IMAGE_BYTES_CAP = 1_500_000;

async function fetchImageAsDataUrl(
  url: string,
  signal?: AbortSignal,
): Promise<{ dataUrl: string; mime: string } | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal, redirect: "follow" });
    if (!response.ok) return undefined;
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!mime.startsWith("image/")) return undefined;
    const buffer = Buffer.from(await response.arrayBuffer());
    // 缩略图体积上限:超限直接跳过,控制 VLM 输入成本。
    if (buffer.byteLength > VLM_CAPTION_IMAGE_BYTES_CAP) return undefined;
    return { dataUrl: `data:${mime};base64,${buffer.toString("base64")}`, mime };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function describeImageWithModel(
  model: NonNullable<ToolExecutionContext["model"]>,
  dataUrl: string,
  mime: string,
  title: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const result = model.streamText({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `Describe this image in one short sentence, in the same language as its title `
                + `"${title}". Reply with the sentence only.`,
            },
            { type: "image", mediaType: mime, dataUrl },
          ],
        },
      ],
      abortSignal: signal,
    });
    let text = "";
    for await (const event of result) {
      if (event.type === "text_delta") text += event.text;
      if (event.type === "error") return undefined;
    }
    const trimmed = text.trim().replace(/\s+/g, " ").slice(0, 200);
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

async function finalizeOutput(
  output: ImageSearchOutput,
  context: ToolExecutionContext,
  summaryMode: "on" | "off" | "vlm",
): Promise<ImageSearchOutput> {
  if (summaryMode !== "vlm") return output;
  const visionModel = context.resolveSearchVisionModel?.();
  if (!visionModel) return output;
  const targets = output.results
    .filter((item): item is ImageResultItem & { thumbnailUrl: string } => Boolean(item.thumbnailUrl))
    .slice(0, VLM_CAPTION_MAX_RESULTS);
  if (targets.length === 0) return output;
  await Promise.all(
    targets.map(async (item) => {
      const image = await fetchImageAsDataUrl(item.thumbnailUrl, context.abortSignal);
      if (!image) return;
      const caption = await describeImageWithModel(
        visionModel,
        image.dataUrl,
        image.mime,
        item.title,
        context.abortSignal,
      );
      if (caption) item.caption = caption;
    }),
  );
  return output;
}

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
    const caption = item.caption ? ` — ${item.caption}` : "";
    lines.push(
      `- ${item.title || "(untitled)"}${caption}${dims}${license}: ${item.originalUrl}`
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
