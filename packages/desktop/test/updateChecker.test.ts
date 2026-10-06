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
