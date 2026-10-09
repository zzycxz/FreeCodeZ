// R21c：helper 安装新鲜度锚点（buildId）必须内容派生——同版本重建 helper 代码变了而
// buildId 不变时，ensureInstalled 判「无漂移」留任旧件（--request-permissions 落到不认识
// 旗标的旧 helper，权限条目建不出来）。本测试钉三件事：① 内容变 → buildId 变；
// ② 同内容 → 稳定可复现；③ 显式 env 覆盖优先。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCuaHelperBuildId } from "./cua-helper-build-id.mjs";

function makePackageRoot(content) {
  const dir = mkdtempSync(join(tmpdir(), "cua-build-id-test-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.6.3" }));
  mkdirSync(join(dir, "macos"));
  writeFileSync(join(dir, "macos", "helper-main.js"), content);
  return dir;
}

test("resolveCuaHelperBuildId：内容派生——代码变则漂移，同内容稳定", () => {
  const rootA = makePackageRoot("console.log('v1');");
  const rootB = makePackageRoot("console.log('v2');");
  try {
    const idA1 = resolveCuaHelperBuildId({}, rootA);
    const idA2 = resolveCuaHelperBuildId({}, rootA);
    const idB = resolveCuaHelperBuildId({}, rootB);
    assert.equal(idA1, idA2, "同内容稳定可复现");
    assert.notEqual(idA1, idB, "helper 代码变化必须让 buildId 漂移（触发 ensureInstalled 重装）");
    assert.match(idA1, /^local-0\.6\.3-[0-9a-f]{12}$/);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("resolveCuaHelperBuildId：显式 env 覆盖优先于内容派生", () => {
  const root = makePackageRoot("console.log('x');");
  try {
    assert.equal(
      resolveCuaHelperBuildId({ FREECODEZ_CUA_HELPER_BUILD_ID: "pinned-42" }, root),
      "pinned-42",
    );
    assert.equal(
      resolveCuaHelperBuildId({ ZCODE_CUA_HELPER_BUILD_ID: "pinned-legacy" }, root),
      "pinned-legacy",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
