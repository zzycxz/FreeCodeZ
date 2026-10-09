// R19 全面复查补：mac Helper 安装器的升级新鲜度（ensureInstalled 按 identity.buildId 钉扎重装）。
// expectedBuildId 经 options 注入（生产值是编译期 define，测试环境为空串会跳过比对）。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCuaHelperInstaller } from "../broker-server.js";
import { HELPER_BUNDLE_ID } from "../broker-helper-constants.js";

function stageBundledHelper(root, buildId) {
  const appDir = join(root, "bundled", "FreeCodeZ Computer Use.app");
  mkdirSync(join(appDir, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(appDir, "Contents", "MacOS", "FreeCodeZ Computer Use"), "macho");
  mkdirSync(join(appDir, "Contents", "Resources"), { recursive: true });
  // Info.plist 必须在：ensureInstalled 的「已安装」快判按 access(Contents/Info.plist)，
  // 缺了它每次调用都走首装分支全量重装——新鲜度比对就永远轮不到。
  writeFileSync(
    join(appDir, "Contents", "Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict/></plist>\n',
  );
  writeFileSync(
    join(appDir, "Contents", "Resources", "identity.json"),
    JSON.stringify({ bundleId: HELPER_BUNDLE_ID, buildId }),
  );
  return appDir;
}

function readInstalledBuildId(installRoot) {
  return JSON.parse(
    readFileSync(join(installRoot, "FreeCodeZ Computer Use.app", "Contents", "Resources", "identity.json"), "utf8"),
  ).buildId;
}

test("ensureInstalled：首装落地 + buildId 一致时不重装 + 漂移时重装（TCC 授权目录原位替换）", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "cua-installer-freshness-"));
  try {
    const installRoot = join(workDir, "install");
    const installer = (expectedBuildId) =>
      createCuaHelperInstaller({
        env: { FREECODEZ_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "1" },
        bundledAppPath: stageBundledHelper(workDir, "build-2"),
        installRoot,
        expectedBuildId,
      });
    // 首装。
    await installer("build-2").ensureInstalled();
    assert.equal(readInstalledBuildId(installRoot), "build-2");
    // 手动把已安装副本摸旧（模拟 app 升级前的旧 helper 残留）。
    writeFileSync(
      join(installRoot, "FreeCodeZ Computer Use.app", "Contents", "Resources", "identity.json"),
      JSON.stringify({ bundleId: HELPER_BUNDLE_ID, buildId: "build-1" }),
    );
    // 期望仍是 build-2 → 重装回 build-2。
    await installer("build-2").ensureInstalled();
    assert.equal(readInstalledBuildId(installRoot), "build-2");
    // 再摸旧 + 期望为空（dev 逃生口形态）→ 不重装，原样保留。
    writeFileSync(
      join(installRoot, "FreeCodeZ Computer Use.app", "Contents", "Resources", "identity.json"),
      JSON.stringify({ bundleId: HELPER_BUNDLE_ID, buildId: "build-1" }),
    );
    await installer("").ensureInstalled();
    assert.equal(readInstalledBuildId(installRoot), "build-1");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
