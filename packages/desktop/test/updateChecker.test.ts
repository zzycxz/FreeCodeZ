// 条目 3（升级实施手册）：更新检查器测试。
// 纯逻辑（版本比较/manifest 解析/404 语义）+ 检查器行为（空 URL 关闭/通知触发/断网静默/受管周期）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  createUpdateChecker,
  parseVersionTag,
  isNewerVersion,
  parseReleaseManifest,
} from "../src/main/updateChecker.js";

test("版本解析：v 前缀/裸三元组；非法 tag undefined", () => {
  assert.deepEqual(parseVersionTag("v1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersionTag("3.14.0"), [3, 14, 0]);
  assert.equal(parseVersionTag("nightly-20261005"), undefined);
  assert.equal(parseVersionTag(undefined), undefined);
});

test("版本比较：仅 latest>current 为真；解析失败保守 false", () => {
  assert.equal(isNewerVersion("v3.15.0", "3.14.3"), true);
  assert.equal(isNewerVersion("v3.14.3", "3.14.3"), false);
  assert.equal(isNewerVersion("v3.14.0", "3.14.3"), false);
  assert.equal(isNewerVersion("junk", "3.14.3"), false);
});

test("manifest 解析：200 有更新带 url/notes；404 与 Not Found 均无更新", () => {
  const newer = parseReleaseManifest(
    200,
    { tag_name: "v9.9.9", html_url: "https://github.com/o/r/releases/tag/v9.9.9", body: "notes here" },
    "1.0.0",
    123,
  );
  assert.equal(newer.hasUpdate, true);
  assert.equal(newer.latestVersion, "v9.9.9");
  assert.equal(newer.releaseUrl?.includes("v9.9.9"), true);
  assert.equal(newer.releaseNotes, "notes here");

  assert.equal(parseReleaseManifest(404, undefined, "1.0.0", 1).hasUpdate, false);
  assert.equal(
    parseReleaseManifest(200, { message: "Not Found" }, "1.0.0", 1).hasUpdate,
    false,
  );
  assert.equal(parseReleaseManifest(200, { tag_name: "v0.1.0" }, "1.0.0", 1).hasUpdate, false);
});

test("检查器：manifestUrl 空 = 功能关闭（零网络）", async () => {
  let fetched = 0;
  const checker = createUpdateChecker({
    currentVersion: "1.0.0",
    manifestUrl: undefined,
    deps: {
      fetchJson: async () => {
        fetched += 1;
        return { status: 200 };
      },
      notify: () => {
        throw new Error("must not notify");
      },
    },
  });
  const result = await checker.checkOnce();
  assert.equal(result.hasUpdate, false);
  assert.equal(fetched, 0);
});

test("检查器：有更新触发通知（带打开链接）；无更新不通知", async () => {
  const notified: unknown[] = [];
  const checker = createUpdateChecker({
    currentVersion: "1.0.0",
    manifestUrl: "https://api.github.com/repos/o/r/releases/latest",
    deps: {
      fetchJson: async () => ({
        status: 200,
        body: { tag_name: "v1.1.0", html_url: "https://x/y" },
      }),
      notify: (input) => notified.push(input),
    },
  });
  await checker.checkOnce();
  assert.equal(notified.length, 1);
  assert.equal((notified[0] as { openUrl?: string }).openUrl, "https://x/y");

  const none = createUpdateChecker({
    currentVersion: "1.1.0",
    manifestUrl: "https://api.github.com/repos/o/r/releases/latest",
    deps: {
      fetchJson: async () => ({ status: 200, body: { tag_name: "v1.1.0" } }),
      notify: () => {
        throw new Error("no update must not notify");
      },
    },
  });
  await none.checkOnce();
});

test("检查器：断网静默不抛（下轮再试）", async () => {
  const checker = createUpdateChecker({
    currentVersion: "1.0.0",
    manifestUrl: "https://api.github.com/repos/o/r/releases/latest",
    deps: {
      fetchJson: async () => {
        throw new Error("ENOTFOUND");
      },
      notify: () => undefined,
    },
  });
  const result = await checker.checkOnce();
  assert.equal(result.hasUpdate, false);
});

test("检查器：受管周期可停（二次 start 不叠 timer）", () => {
  const checker = createUpdateChecker({
    currentVersion: "1.0.0",
    manifestUrl: undefined,
    deps: { fetchJson: async () => ({ status: 200 }), notify: () => undefined },
  });
  checker.startPeriodic(60_000);
  checker.startPeriodic(60_000);
  checker.stopPeriodic();
  checker.stopPeriodic();
});

test("默认源：设置为空→回落 FreeCodeZ 端点 releases/latest；显式 URL 覆盖", async () => {
  const { resolveManifestUrl, DEFAULT_UPDATE_MANIFEST_PATH } = await import("../src/main/updateChecker.js");
  assert.equal(DEFAULT_UPDATE_MANIFEST_PATH, "/releases/latest");
  assert.equal(
    resolveManifestUrl(undefined, "https://freecodez.local"),
    "https://freecodez.local/releases/latest",
  );
  assert.equal(
    resolveManifestUrl(undefined, "https://freecodez.local/"),
    "https://freecodez.local/releases/latest",
  );
  assert.equal(
    resolveManifestUrl("https://api.github.com/repos/o/r/releases/latest", "https://freecodez.local"),
    "https://api.github.com/repos/o/r/releases/latest",
  );
  assert.equal(resolveManifestUrl(undefined, ""), undefined);
  assert.equal(resolveManifestUrl("  ", "https://x"), "https://x/releases/latest");
});

test("退避计划：限流 Retry-After 头优先（90s）；指数退避有 30s 下限；4xx 不早重试", async () => {
  const { planUpdateRetry, UPDATE_RETRY_FLOOR_MS } = await import("../src/main/updateChecker.js");
  const fixed = () => 0;
  const rateLimitHeader = planUpdateRetry({
    status: 429,
    retryAfterSeconds: 90,
    attempt: 1,
    nowMs: 0,
    random: fixed,
  });
  assert.equal(rateLimitHeader.retry, true);
  assert.equal(rateLimitHeader.reason, "rate_limit");
  assert.equal(rateLimitHeader.backoffMs, 90_000);

  const rateLimitBody = planUpdateRetry({
    status: 403,
    bodyText: "API rate limit exceeded ... retry after 60s. (reset at 2026-10-06T12:00:00Z, remaining 0)",
    attempt: 2,
    nowMs: 0,
    random: fixed,
  });
  assert.equal(rateLimitBody.reason, "rate_limit");
  assert.equal(rateLimitBody.backoffMs, 60_000);

  const network = planUpdateRetry({ attempt: 1, nowMs: 0, random: fixed });
  assert.equal(network.reason, "network");
  assert.equal(network.backoffMs, UPDATE_RETRY_FLOOR_MS, "指数起步 2s 被下限抬到 30s");

  const server = planUpdateRetry({ status: 503, attempt: 3, nowMs: 0, random: fixed });
  assert.equal(server.reason, "server");
  assert.equal(server.backoffMs, Math.max(2_000 * 2 ** 2, UPDATE_RETRY_FLOOR_MS));

  const client = planUpdateRetry({ status: 400, attempt: 1, nowMs: 0, random: fixed });
  assert.equal(client.retry, false);
  assert.equal(client.reason, "client_error");
});

test("检查器：失败结果携带退避计划；成功重置拍数", async () => {
  const { createUpdateChecker, UPDATE_RETRY_FLOOR_MS } = await import("../src/main/updateChecker.js");
  let respond: () => { status: number; body?: unknown; retryAfterSeconds?: number } = () => ({
    status: 429,
    retryAfterSeconds: 90,
  });
  const checker = createUpdateChecker({
    currentVersion: "1.0.0",
    manifestUrl: "https://x/releases/latest",
    deps: {
      fetchJson: async () => respond(),
      notify: () => undefined,
      random: () => 0,
    },
  });
  const failed = await checker.checkOnce();
  assert.equal(failed.failure?.retry, true);
  assert.equal(failed.failure?.backoffMs, 90_000);

  respond = () => ({ status: 503 });
  const retried = await checker.checkOnce();
  assert.equal(retried.failure?.reason, "server");
  assert.equal(retried.failure?.backoffMs, UPDATE_RETRY_FLOOR_MS);

  respond = () => ({ status: 404 });
  const ok = await checker.checkOnce();
  assert.equal(ok.failure, undefined);
  respond = () => ({ status: 503 });
  const fresh = await checker.checkOnce();
  assert.equal(fresh.failure?.backoffMs, UPDATE_RETRY_FLOOR_MS, "成功后拍数归零，从下限重来");
});
