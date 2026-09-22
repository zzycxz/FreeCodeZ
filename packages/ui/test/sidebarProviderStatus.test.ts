import assert from "node:assert/strict";
import test from "node:test";
import { resolveSidebarProviderKeyHealth } from "../src/lib/sidebarProviderStatus.js";

// docs/spec/sidebar-provider-key-status.md §2 三态映射：未配置 / 有效 / 失效

test("无 provider 条目为未配置", () => {
  assert.equal(resolveSidebarProviderKeyHealth(null), "not-configured");
  assert.equal(resolveSidebarProviderKeyHealth(undefined), "not-configured");
});

test("executable 且未停用为有效", () => {
  assert.equal(
    resolveSidebarProviderKeyHealth({ enabled: true, executable: true, hasPersonalConfig: true }),
    "ready",
  );
  // enabled 缺省视为未显式停用
  assert.equal(resolveSidebarProviderKeyHealth({ executable: true }), "ready");
});

test("停用归入失效", () => {
  assert.equal(
    resolveSidebarProviderKeyHealth({ enabled: false, executable: true, hasPersonalConfig: true }),
    "invalid",
  );
  assert.equal(resolveSidebarProviderKeyHealth({ enabled: false }), "invalid");
});

test("保存过配置但不可执行为失效", () => {
  assert.equal(
    resolveSidebarProviderKeyHealth({
      enabled: true,
      executable: false,
      hasPersonalConfig: true,
    }),
    "invalid",
  );
});

test("从未保存个人配置为未配置", () => {
  assert.equal(
    resolveSidebarProviderKeyHealth({
      enabled: true,
      executable: false,
      hasPersonalConfig: false,
    }),
    "not-configured",
  );
  assert.equal(resolveSidebarProviderKeyHealth({ enabled: true, executable: false }), "not-configured");
});
