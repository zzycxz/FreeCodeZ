// 条目 11（升级实施手册）：PR 双层工具集基建三件测试。
// 分页（nextOffset 语义+文件边界）/乐观并发（stale_head 闭集）/限流三件套（解析/退避/重试判定）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  splitPrDiffFiles,
  paginatePrDiff,
  verifyExpectedHeadRevision,
  parseGhRateLimit,
  computeBackoffMs,
  shouldRetryOnGhError,
} from "../src/pr-ops.js";

function makeDiff(fileCount: number): string {
  return Array.from(
    { length: fileCount },
    (_, index) =>
      `diff --git a/f${index}.ts b/f${index}.ts\nindex 111..222 100644\n--- a/f${index}.ts\n+++ b/f${index}.ts\n@@ -1 +1 @@\n-old${index}\n+new${index}\n`,
  ).join("");
}

test("PR diff 切文件与分页：>500 文件分页读完", () => {
  const diff = makeDiff(520);
  assert.equal(splitPrDiffFiles(diff).length, 520);
  // 分页读完
  let offset = 0;
  let pages = 0;
  let collected = 0;
  for (;;) {
    const page = paginatePrDiff(diff, { offset, limit: 100 });
    pages += 1;
    collected += page.shown;
    assert.equal(page.totalFiles, 520);
    if (!page.nextOffset) break;
    offset = page.nextOffset;
  }
  assert.equal(collected, 520, "全部文件经分页读完（验收：>500 文件分页读完）");
  assert.equal(pages, 6, "520/100 → 6 页");
  // 单页形状
  const first = paginatePrDiff(diff, { offset: 0, limit: 2 });
  assert.ok(first.content.includes("f0.ts") && first.content.includes("f1.ts"));
  assert.equal(first.nextOffset, 2);
  assert.equal(first.truncated, true);
});

test("分页：非 diff 文本单段；空文本零页", () => {
  const single = paginatePrDiff("just text", {});
  assert.equal(single.shown, 1);
  assert.equal(single.nextOffset, undefined);
  const empty = paginatePrDiff("", {});
  assert.equal(empty.totalFiles, 0);
});

test("乐观并发：stale_head 闭集；未声明期望放行；读不到当前 head 拒盲写", () => {
  assert.deepEqual(verifyExpectedHeadRevision("abc123", undefined), { ok: true });
  assert.deepEqual(verifyExpectedHeadRevision("abc123", "abc123"), { ok: true });
  const stale = verifyExpectedHeadRevision("def456", "abc123");
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.code, "stale_head");
    assert.ok(stale.message.includes("re-read and retry"));
    assert.ok(stale.message.includes("abc123"), "短 sha 原样展示");
  }
  const blind = verifyExpectedHeadRevision(undefined, "abc123");
  assert.equal(blind.ok, false);
  if (!blind.ok) assert.equal(blind.code, "stale_head");
});

test("限流解析：Retry-After 秒/primary reset at ISO/remaining", () => {
  const info = parseGhRateLimit(
    "You have exceeded a secondary rate limit. Please retry after 30s.",
  );
  assert.equal(info.retryAfterMs, 30_000);
  const primary = parseGhRateLimit(
    "API rate limit exceeded for user. reset at 2026-10-06T00:00:00Z remaining: 0",
  );
  assert.equal(primary.remaining, 0);
  assert.equal(primary.resetAtMs, Date.parse("2026-10-06T00:00:00Z"));
});

test("退避：Retry-After 优先；缺省指数+jitter+cap", () => {
  // 服务端指明 30s → 尊重
  assert.equal(
    computeBackoffMs({ attempt: 5, rateLimit: { retryAfterMs: 30_000 } }),
    30_000,
  );
  // resetAt 距今 10s → 10s
  const now = Date.now();
  assert.equal(
    computeBackoffMs({ attempt: 1, rateLimit: { resetAtMs: now + 10_000 }, nowMs: now }),
    10_000,
  );
  // 指数：attempt1=2s+0 jitter；attempt3=8s±20%
  const a1 = computeBackoffMs({ attempt: 1, random: () => 0 });
  assert.equal(a1, 2_000);
  const a3 = computeBackoffMs({ attempt: 3, random: () => 1 });
  assert.equal(a3, 9_600, "8s+20%=9.6s");
  // cap 60s
  const big = computeBackoffMs({ attempt: 20, random: () => 0 });
  assert.equal(big, 60_000);
});

test("重试判定：限流/5xx/network 可重试；4xx 客户端错不可", () => {
  assert.deepEqual(shouldRetryOnGhError({ text: "rate limit exceeded" }), { retry: true, reason: "rate_limit" });
  assert.deepEqual(shouldRetryOnGhError({ status: 429 }), { retry: true, reason: "rate_limit" });
  assert.deepEqual(shouldRetryOnGhError({ status: 502 }), { retry: true, reason: "server" });
  assert.deepEqual(shouldRetryOnGhError({}), { retry: true, reason: "network" });
  assert.deepEqual(shouldRetryOnGhError({ status: 404 }), { retry: false, reason: "client_error" });
  assert.deepEqual(shouldRetryOnGhError({ status: 403, text: "Resource not accessible" }), { retry: false, reason: "client_error" });
});
