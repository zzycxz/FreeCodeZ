// R19（mac Helper 自研产线）：产线脚本纯函数 + afterPack 校验器 darwin 分支测试。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHelperIdentityJson,
  buildHelperInfoPlist,
  pruneKoffiToTargetPlatform,
} from "../../../scripts/build-cua-helper-app.mjs";
import { HELPER_BUNDLE_ID } from "../../../packages/zcode-cua/broker-helper-constants.js";
import {
  resolveCuaAssetsResourcesDir,
  verifyCuaPluginAssets,
} from "../scripts/koffi-package-assets.mjs";

test("buildHelperInfoPlist：R20 身份键 app.freecodez.* + LSUIElement + 用途描述", () => {
  const plist = buildHelperInfoPlist({
    executableName: "FreeCodeZ Computer Use",
    bundleId: HELPER_BUNDLE_ID,
    version: "1.2.3",
  });
  assert.ok(plist.includes(`<key>CFBundleIdentifier</key>\n\t<string>${HELPER_BUNDLE_ID}</string>`));
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>FreeCodeZ Computer Use<\/string>/);
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>1\.2\.3<\/string>/);
  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
  assert.match(plist, /<key>NSAppleEventsUsageDescription<\/key>\s*<string>FreeCodeZ Computer Use needs to control System Events/);
});

test("buildHelperIdentityJson：安装验签锚 bundleId 透传", () => {
  const identity = JSON.parse(
    buildHelperIdentityJson({
      bundleId: HELPER_BUNDLE_ID,
      displayName: "FreeCodeZ Computer Use",
      executableName: "FreeCodeZ Computer Use",
      version: "1.2.3",
      buildId: "local-0.6.3",
    }),
  );
  assert.equal(identity.bundleId, HELPER_BUNDLE_ID);
  assert.equal(identity.schemaVersion, 1);
  assert.equal(identity.buildId, "local-0.6.3");
});

test("pruneKoffiToTargetPlatform：只留目标平台，目标缺失即抛", () => {
  const workDir = mkdtempSync(join(tmpdir(), "cua-helper-prune-test-"));
  try {
    const buildKoffi = join(workDir, "build", "koffi");
    for (const platform of ["darwin_arm64", "linux_arm64", "win32_x64"]) {
      mkdirSync(join(buildKoffi, platform), { recursive: true });
      writeFileSync(join(buildKoffi, platform, "koffi.node"), "fake");
    }
    pruneKoffiToTargetPlatform(workDir, "darwin", "arm64");
    assert.deepEqual(readdirSync(buildKoffi), ["darwin_arm64"]);
    assert.throws(() => pruneKoffiToTargetPlatform(workDir, "darwin", "x64"), /not found/);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("resolveCuaAssetsResourcesDir：afterPack 资源目录按平台取位（R19 首版踩坑回归锚）", () => {
  assert.equal(
    resolveCuaAssetsResourcesDir({
      electronPlatformName: "darwin",
      appOutDir: "/out/mac-arm64",
      productFilename: "FreeCodeZ",
    }),
    "/out/mac-arm64/FreeCodeZ.app/Contents/Resources",
  );
  assert.equal(
    resolveCuaAssetsResourcesDir({
      electronPlatformName: "win32",
      appOutDir: "/out/win",
      productFilename: "FreeCodeZ",
    }),
    "/out/win/resources",
  );
});

test("verifyCuaPluginAssets darwin 分支：齐全通过 / identity 漂移与结构缺失各自报错", () => {
  const workDir = mkdtempSync(join(tmpdir(), "cua-verify-darwin-test-"));
  try {
    const resourcesDir = join(workDir, "resources");
    const helperApp = join(resourcesDir, "cua-helper", "FreeCodeZ Computer Use.app");
    mkdirSync(join(helperApp, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(helperApp, "Contents", "MacOS", "FreeCodeZ Computer Use"), "macho");
    mkdirSync(join(helperApp, "Contents", "Resources", "dist"), { recursive: true });
    writeFileSync(join(helperApp, "Contents", "Resources", "dist", "helper-main.mjs"), "entry");
    mkdirSync(
      join(helperApp, "Contents", "Resources", "node_modules", "koffi", "build", "koffi", "darwin_arm64"),
      { recursive: true },
    );
    writeFileSync(
      join(helperApp, "Contents", "Resources", "node_modules", "koffi", "build", "koffi", "darwin_arm64", "koffi.node"),
      "native",
    );
    writeFileSync(
      join(helperApp, "Contents", "Resources", "identity.json"),
      JSON.stringify({ bundleId: HELPER_BUNDLE_ID }),
    );
    const pluginKoffi = join(resourcesDir, "glm", "packages", "zcode-cua-plugin", "node_modules");
    mkdirSync(join(pluginKoffi, "koffi", "build", "koffi", "darwin_arm64"), { recursive: true });
    writeFileSync(join(pluginKoffi, "koffi", "index.js"), "");
    writeFileSync(join(pluginKoffi, "koffi", "build", "koffi", "darwin_arm64", "koffi.node"), "native");
    mkdirSync(join(pluginKoffi, "sharp"), { recursive: true });
    writeFileSync(join(pluginKoffi, "sharp", "package.json"), "{}");
    const targetPlatform = { os: "darwin", arch: "arm64" };

    assert.deepEqual(verifyCuaPluginAssets({ resourcesDir, targetPlatform }), []);

    writeFileSync(
      join(helperApp, "Contents", "Resources", "identity.json"),
      JSON.stringify({ bundleId: "dev.zcode.cua-helper" }),
    );
    const identityErrors = verifyCuaPluginAssets({ resourcesDir, targetPlatform });
    assert.equal(identityErrors.length, 1);
    assert.match(identityErrors[0], /bundleId mismatch/);

    writeFileSync(
      join(helperApp, "Contents", "Resources", "identity.json"),
      JSON.stringify({ bundleId: HELPER_BUNDLE_ID }),
    );
    rmSync(join(helperApp, "Contents", "Resources", "dist", "helper-main.mjs"));
    const structureErrors = verifyCuaPluginAssets({ resourcesDir, targetPlatform });
    assert.equal(structureErrors.length, 1);
    assert.match(structureErrors[0], /missing mac CUA helper entry/);

    // 平台隔离：win32 分支只看 tools/cua-helper（vendored），darwin 形状的 fixture 下
    // 恰好报 helper 依赖与 manifest 两条缺失，且不触发 darwin 的 .app 断言。
    const winPlatform = { os: "win32", arch: "x64" };
    const winErrors = verifyCuaPluginAssets({ resourcesDir, targetPlatform: winPlatform });
    assert.equal(winErrors.length, 2);
    assert.match(winErrors.join("\n"), /missing helper runtime dependency/);
    assert.match(winErrors.join("\n"), /missing CUA helper runtime manifest/);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
