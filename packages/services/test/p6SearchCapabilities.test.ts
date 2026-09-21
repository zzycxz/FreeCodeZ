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
