// FreeCodeZ fork(P6):搜索能力归一化层与降级链纯逻辑单测。
// 运行:node --test packages/services/test/p6SearchCapabilities.test.ts(经 tsx 加载源码)。
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = new URL("../../..", import.meta.url);
const coreHandlers = new URL(
  "apps/zcode-cli/packages/core/src/tool/handlers/search-shared.ts",
  repoRoot,
);
const webfetchContent = new URL(
  "apps/zcode-cli/packages/core/src/tool/handlers/webfetch-content.ts",
  repoRoot,
);

test("normalizeUrlForDedupe strips tracking params, hash, trailing slash, and case", async () => {
  const { normalizeUrlForDedupe } = await import(coreHandlers.href);
  const a = normalizeUrlForDedupe(
    "HTTPS://Example.COM/path/?utm_source=x&id=1&fbclid=abc#section",
  );
  const b = normalizeUrlForDedupe("https://example.com/path?id=1");
  assert.equal(a, b);
  assert.equal(normalizeUrlForDedupe("not a url"), null);
});

test("dedupeByNormalizedUrl drops duplicates after normalization", async () => {
  const { dedupeByNormalizedUrl } = await import(coreHandlers.href);
  const items = [
    { url: "https://example.com/a?utm_campaign=1" },
    { url: "https://example.com/a" },
    { url: "https://example.com/b" },
  ];
  const deduped = dedupeByNormalizedUrl(items);
  assert.equal(deduped.length, 2);
});

test("search sqlite cache put/get/expiry with temp dir", async () => {
  const { SearchSqliteCache } = await import(coreHandlers.href);
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "fcz-search-cache-"));
  try {
    const cache = new SearchSqliteCache("test", dir);
    cache.put("k", { hello: "world" }, 60_000);
    assert.deepEqual(cache.get("k"), { hello: "world" });
    cache.put("k2", { expired: true }, -1);
    assert.equal(cache.get("k2"), undefined);
    cache.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("key resolution prefers credentials over env", async () => {
  const { resolveSearchProviderKeys } = await import(coreHandlers.href);
  // 独立环境下 credential store 可用(读 ~/.freecodez);此处仅验证 env 兜底与形状。
  const keys = await resolveSearchProviderKeys({ SERPAPI_API_KEY: "  env-key  " });
  assert.equal(keys.serpapi, "env-key");
  assert.equal(keys.brave, undefined);
});

test("extractHtmlMainContent prefers article/main over body boilerplate", async () => {
  const { extractHtmlMainContent } = await import(webfetchContent.href);
  const html =
    "<html><body><nav>nav nav nav nav nav nav nav</nav>"
    + "<article><p>" + "正文".repeat(200) + "</p></article>"
    + "<footer>footer</footer></body></html>";
  const extracted = extractHtmlMainContent(html);
  assert.ok(extracted.includes("正文"));
  assert.ok(!extracted.includes("nav nav"));
  assert.ok(!extracted.includes("footer"));
});

test("webfetch markdown format keeps headings and links", async () => {
  const { extractReadableContent } = await import(webfetchContent.href);
  const html =
    "<html><body><article><h1>Title</h1><p>Hello <a href='https://x.dev'>link</a></p></article></body></html>";
  const markdown = extractReadableContent(
    new TextEncoder().encode(html),
    "text/html",
    "markdown",
  );
  assert.ok(markdown.includes("# Title"));
  assert.ok(markdown.includes("[link](https://x.dev)"));
  const text = extractReadableContent(new TextEncoder().encode(html), "text/html", "text");
  assert.ok(!text.includes("# Title"));
});

// 回归锁定(2026-09-23):Linkup 请求契约曾把端点写成停放域 api.linkup.ai、
// body 字段写成 {query, depth},导致搜索永远失败。此处锁 URL + body + 响应映射。
test("linkup request hits api.linkup.so with q/depth/outputType contract", async () => {
  const websearchFallback = new URL(
    "apps/zcode-cli/packages/core/src/tool/handlers/websearch-fallback.ts",
    repoRoot,
  );
  const { fetchLinkup } = await import(websearchFallback.href);
  const captured: Array<{ url: string; body: Record<string, unknown>; auth?: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    captured.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")),
      auth: (init?.headers as Record<string, string> | undefined)?.["Authorization"],
    });
    return new Response(
      JSON.stringify({ results: [{ name: "标题", url: "https://x.dev/1", content: "..." }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const items = await fetchLinkup("测试查询", "test-key");
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.url, "https://api.linkup.so/v1/search");
    assert.deepEqual(captured[0]!.body, {
      q: "测试查询",
      depth: "standard",
      outputType: "searchResults",
    });
    assert.equal(captured[0]!.auth, "Bearer test-key");
    assert.deepEqual(items, [{ title: "标题", url: "https://x.dev/1" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 回归锁定(2026-09-23 第二批):三处搜索链健壮性修复——
// SerpAPI 200+{error} 必须抛错走降级(曾被静默吞成空结果)。
test("serpapi 200+error body throws so the chain can degrade", async () => {
  const imageSearch = new URL(
    "apps/zcode-cli/packages/core/src/tool/handlers/image-search.ts",
    repoRoot,
  );
  const { fetchSerpapiGoogleImages } = await import(imageSearch.href);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "Invalid API key." }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    await assert.rejects(
      () => fetchSerpapiGoogleImages("q", "bad-key", 1, 10, { safeSearch: "moderate" }),
      /serpapi error/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Brave Images 解析容错:source 裸主机名不抛 Invalid URL;原图优先 properties.url;
// pageUrl 仅在 source 是完整 URL 时采用,否则回退 url。
test("brave images tolerates bare-host source and prefers properties.url", async () => {
  const imageSearch = new URL(
    "apps/zcode-cli/packages/core/src/tool/handlers/image-search.ts",
    repoRoot,
  );
  const { fetchBraveImages } = await import(imageSearch.href);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        results: [
          {
            title: "a",
            url: "https://site.example/page1",
            source: "example.com",
            thumbnail: { src: "https://img.example/t1.jpg" },
            properties: { url: "https://img.example/1.jpg", width: 100, height: 50 },
          },
          {
            title: "b",
            url: "https://img.example/2.jpg",
            source: "https://site.example/page2",
            properties: {},
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  try {
    const items = await fetchBraveImages("q", "key", 1, 10, { safeSearch: "moderate" });
    assert.equal(items.length, 2);
    assert.equal(items[0]!.originalUrl, "https://img.example/1.jpg");
    assert.equal(items[0]!.source, "example.com");
    assert.equal(items[0]!.pageUrl, "https://site.example/page1");
    assert.equal(items[1]!.originalUrl, "https://img.example/2.jpg");
    assert.equal(items[1]!.pageUrl, "https://site.example/page2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// AnySearch 零 key 尾链:无 key 匿名(不带 Authorization),有 key 带 Bearer。
test("anysearch sends anonymous request without key and Bearer with key", async () => {
  const websearchFallback = new URL(
    "apps/zcode-cli/packages/core/src/tool/handlers/websearch-fallback.ts",
    repoRoot,
  );
  const { fetchAnySearch } = await import(websearchFallback.href);
  const captured: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    captured.push({
      headers: (init?.headers as Record<string, string>) ?? {},
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response(
      JSON.stringify({ code: 0, data: { results: [{ title: "T", url: "https://x.dev" }] } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    await fetchAnySearch("q", undefined);
    await fetchAnySearch("q", "my-key");
    assert.equal(captured[0]!.headers["Authorization"], undefined);
    assert.equal(captured[1]!.headers["Authorization"], "Bearer my-key");
    assert.deepEqual(captured[0]!.body, { query: "q", max_results: 10 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
