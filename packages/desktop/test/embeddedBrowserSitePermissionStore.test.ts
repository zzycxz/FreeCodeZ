// U2-4（移植自 ZCode 3.15.1）站点权限 store 测试：set/get/reset/clear + 原子持久化往返
// + 损坏文件回退空表（load 白名单清洗语义）。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddedBrowserSitePermissionStore } from "../src/main/embeddedBrowserPermissionPolicy.js";

test("set/get/reset/clear 内存语义", async () => {
  const dir = mkdtempSync(join(tmpdir(), "site-perm-"));
  const file = join(dir, "permissions.json");
  const { store, load, flush } = createEmbeddedBrowserSitePermissionStore(file);
  await load();
  assert.equal(store.get("https://a.example", "media"), undefined);
  store.set("https://a.example", "media", "allow");
  store.set("https://a.example", "geolocation", "deny");
  assert.equal(store.get("https://a.example", "media"), "allow");
  assert.equal(store.get("https://a.example", "geolocation"), "deny");
  store.reset("https://a.example", "media");
  assert.equal(store.get("https://a.example", "media"), undefined);
  assert.equal(store.get("https://a.example", "geolocation"), "deny");
  store.clear();
  assert.equal(store.get("https://a.example", "geolocation"), undefined);
  await flush();
  rmSync(dir, { recursive: true, force: true });
});

test("持久化往返：set 后新实例 load 读回；损坏文件回退空表", async () => {
  const dir = mkdtempSync(join(tmpdir(), "site-perm-"));
  const file = join(dir, "permissions.json");
  const first = createEmbeddedBrowserSitePermissionStore(file);
  await first.load();
  first.store.set("https://b.example", "notifications", "deny");
  await first.flush();
  const second = createEmbeddedBrowserSitePermissionStore(file);
  await second.load();
  assert.equal(second.store.get("https://b.example", "notifications"), "deny");

  writeFileSync(file, "{corrupt", "utf8");
  const third = createEmbeddedBrowserSitePermissionStore(file);
  await third.load();
  assert.equal(third.store.get("https://b.example", "notifications"), undefined);
  rmSync(dir, { recursive: true, force: true });
});
