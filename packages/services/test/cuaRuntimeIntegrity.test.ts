// A10/A11(规格 docs/spec/computer-control-capability.md §7):runtime-manifest 校验器 fail-closed——
// electronVersion 篡改拒载(incompatible-runtime-manifest),entry 一字节篡改拒载(artifact-integrity-mismatch)。
// A19(R16 confused-deputy):broker 凭据同批才有效、半组即清、sanitize/passthrough 双面剔除。
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveWindowsCuaRuntime,
  WindowsCuaDevRuntimeResolutionError,
} from "../src/cua-permission-broker/windowsCuaDevRuntime.js";
import {
  getCapturedZCodeCuaBrokerCredentials,
  readZCodeToolEnvPassthroughEnv,
  resetCapturedZCodeCuaBrokerCredentialsForTest,
  sanitizeZCodeRuntimeEnv,
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
} from "../../shared/src/runtimeEnv.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const vendoredHelper = join(
  repoRoot,
  "apps",
  "zcode-cli",
  "dependencies",
  "zcode-cua",
  "helper-runtime",
);

function stageHelperResources() {
  const resources = mkdtempSync(join(tmpdir(), "cua-integrity-"));
  const helperRoot = join(resources, "tools", "cua-helper");
  mkdirSync(join(helperRoot, "dist"), { recursive: true });
  mkdirSync(join(helperRoot, "build", "Release"), { recursive: true });
  cpSync(
    join(vendoredHelper, "dist", "windows-helper.js"),
    join(helperRoot, "dist", "windows-helper.js"),
  );
  cpSync(
    join(vendoredHelper, "build", "Release", "ax_native.node"),
    join(helperRoot, "build", "Release", "ax_native.node"),
  );
  cpSync(join(vendoredHelper, "runtime-manifest.json"), join(helperRoot, "runtime-manifest.json"));
  return { resources, helperRoot };
}

function resolveOptions(resources: string) {
  return {
    platform: "win32" as NodeJS.Platform,
    arch: "x64" as NodeJS.Architecture,
    electronVersion: "41.0.3",
    resourcesPath: resources,
  };
}

test("正例:原样 vendored 树通过 manifest 校验(防过度拒绝)", async () => {
  const { resources } = stageHelperResources();
  try {
    const runtime = await resolveWindowsCuaRuntime(resolveOptions(resources));
    assert.ok(runtime.entryPath.endsWith("windows-helper.js"));
    assert.ok(runtime.addonPath.endsWith("ax_native.node"));
  } finally {
    rmSync(resources, { recursive: true, force: true });
  }
});

test("A10:manifest electronVersion 篡改即 fail-closed(incompatible-runtime-manifest)", async () => {
  const { resources, helperRoot } = stageHelperResources();
  try {
    const manifestPath = join(helperRoot, "runtime-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.electronVersion = "0.0.0";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => resolveWindowsCuaRuntime(resolveOptions(resources)),
      (error: unknown) => {
        assert.ok(error instanceof WindowsCuaDevRuntimeResolutionError);
        assert.equal(error.reason, "incompatible-runtime-manifest");
        return true;
      },
    );
  } finally {
    rmSync(resources, { recursive: true, force: true });
  }
});

test("A11:entry 一字节篡改即 fail-closed(artifact-integrity-mismatch)", async () => {
  const { resources, helperRoot } = stageHelperResources();
  try {
    const entryPath = join(helperRoot, "dist", "windows-helper.js");
    const bytes = readFileSync(entryPath);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    writeFileSync(entryPath, bytes);
    await assert.rejects(
      () => resolveWindowsCuaRuntime(resolveOptions(resources)),
      (error: unknown) => {
        assert.ok(error instanceof WindowsCuaDevRuntimeResolutionError);
        assert.equal(error.reason, "artifact-integrity-mismatch");
        return true;
      },
    );
  } finally {
    rmSync(resources, { recursive: true, force: true });
  }
});

test("A19:凭据组同批才有效,sanitize 剔除全部凭据键", () => {
  resetCapturedZCodeCuaBrokerCredentialsForTest();
  const env = {
    [ZCODE_CUA_BROKER_SOCKET_ENV_KEY]: "pipe-x",
    [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: "auth-1",
    ZCODE_CUA_PERMISSION_BROKER_TOKEN: "legacy-t",
    ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER: "marker-1",
    PATH: "keep-me",
  };
  const sanitized = sanitizeZCodeRuntimeEnv(env);
  assert.equal(sanitized[ZCODE_CUA_BROKER_SOCKET_ENV_KEY], undefined);
  assert.equal(sanitized[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY], undefined);
  assert.equal(sanitized.ZCODE_CUA_PERMISSION_BROKER_TOKEN, undefined);
  assert.equal(sanitized.ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER, undefined);
  assert.equal(sanitized.PATH, "keep-me");
  const captured = getCapturedZCodeCuaBrokerCredentials();
  assert.equal(captured.socket, "pipe-x");
  assert.equal(captured.pluginAuthority, "auth-1");
  assert.equal(captured.refreshMarker, "marker-1");
});

test("A19:半组凭据 fail-closed 清空(不构成有效凭据组)", () => {
  resetCapturedZCodeCuaBrokerCredentialsForTest();
  sanitizeZCodeRuntimeEnv({
    [ZCODE_CUA_BROKER_SOCKET_ENV_KEY]: "pipe-only",
  });
  const captured = getCapturedZCodeCuaBrokerCredentials();
  assert.equal(captured.socket, undefined);
  assert.equal(captured.pluginAuthority, undefined);
});

test("A19:tool-env-passthrough 不恢复凭据键(confused-deputy 双面剔除)", () => {
  const passthrough = readZCodeToolEnvPassthroughEnv({
    ZCODE_TOOL_ENV_PASSTHROUGH_JSON: JSON.stringify({
      [ZCODE_CUA_BROKER_SOCKET_ENV_KEY]: "pipe-x",
      [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: "auth-1",
      GOOD_KEY: "v",
    }),
  });
  // passthrough 白名单只覆盖 sanitize 剔除面的 zcode 运行时键;安全本体 = 凭据键永不可恢复。
  assert.equal(passthrough[ZCODE_CUA_BROKER_SOCKET_ENV_KEY], undefined);
  assert.equal(passthrough[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY], undefined);
  assert.equal(passthrough.ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER, undefined);
});
