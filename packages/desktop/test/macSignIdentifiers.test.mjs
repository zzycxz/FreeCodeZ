// R21 安装包签名标识钉扎（mac-sign-identifiers）测试：
// ① Helper 命名→标识映射与官方 ZCode 惯例同构（<appId>.helper[.GPU|Plugin|Renderer]），未知形态 fail-closed；
// ② 规划顺序 Helpers 先、主 app 最后（外层封内层），entitlements 主/继承分面；
// ③ 执行器 argv 形状（codesign --force --sign - --entitlements … --identifier …）；
// ④ Frameworks 扫描只取产品族 Helper*.app。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMacAdhocSignIdentifiers,
  discoverHelperBundleNames,
  helperSignIdentifier,
  planMacAdhocSignIdentifiers,
} from "../scripts/mac-sign-identifiers.mjs";

test("helperSignIdentifier：四形态映射与官方惯例同构；未知形态 fail-closed", () => {
  assert.equal(helperSignIdentifier("app.freecodez.app", "Helper"), "app.freecodez.app.helper");
  assert.equal(
    helperSignIdentifier("app.freecodez.app", "Helper (GPU)"),
    "app.freecodez.app.helper.GPU",
  );
  assert.equal(
    helperSignIdentifier("app.freecodez.app", "Helper (Plugin)"),
    "app.freecodez.app.helper.Plugin",
  );
  assert.equal(
    helperSignIdentifier("app.freecodez.app", "Helper (Renderer)"),
    "app.freecodez.app.helper.Renderer",
  );
  assert.throws(() => helperSignIdentifier("app.freecodez.app", "Helper (XPC)"), /unexpected/);
});

test("planMacAdhocSignIdentifiers：Helpers 先主 app 后；标识与 entitlements 分面正确", () => {
  const steps = planMacAdhocSignIdentifiers({
    appBundlePath: "/out/FreeCodeZ.app",
    helperBundleNames: ["FreeCodeZ Helper", "FreeCodeZ Helper (GPU)"],
    appId: "app.freecodez.app",
    productFilename: "FreeCodeZ",
    entitlementsMain: "/build/entitlements.mac.plist",
    entitlementsInherit: "/build/entitlements.mac.inherit.plist",
  });
  assert.deepEqual(
    steps.map((step) => step.identifier),
    ["app.freecodez.app.helper", "app.freecodez.app.helper.GPU", "app.freecodez.app"],
    "Helpers 先签、主 app 最后",
  );
  assert.equal(steps[0].entitlements, "/build/entitlements.mac.inherit.plist");
  assert.equal(steps[2].entitlements, "/build/entitlements.mac.plist");
  assert.equal(steps[2].targetPath, "/out/FreeCodeZ.app");
  assert.equal(
    steps[1].targetPath,
    "/out/FreeCodeZ.app/Contents/Frameworks/FreeCodeZ Helper (GPU).app",
  );
  assert.throws(
    () =>
      planMacAdhocSignIdentifiers({
        appBundlePath: "/out/FreeCodeZ.app",
        helperBundleNames: ["Other Helper"],
        appId: "app.freecodez.app",
        productFilename: "FreeCodeZ",
        entitlementsMain: "/e1",
        entitlementsInherit: "/e2",
      }),
    /outside product family/,
  );
});

test("applyMacAdhocSignIdentifiers：argv 形状与顺序、失败上抛", () => {
  const calls = [];
  const steps = planMacAdhocSignIdentifiers({
    appBundlePath: "/out/FreeCodeZ.app",
    helperBundleNames: ["FreeCodeZ Helper"],
    appId: "app.freecodez.app",
    productFilename: "FreeCodeZ",
    entitlementsMain: "/e1",
    entitlementsInherit: "/e2",
  });
  const count = applyMacAdhocSignIdentifiers(steps, (args) => {
    calls.push(args);
  });
  assert.equal(count, 2);
  assert.deepEqual(calls[0], [
    "--force",
    "--sign",
    "-",
    "--entitlements",
    "/e2",
    "--identifier",
    "app.freecodez.app.helper",
    "/out/FreeCodeZ.app/Contents/Frameworks/FreeCodeZ Helper.app",
  ]);
  assert.deepEqual(calls[1], [
    "--force",
    "--sign",
    "-",
    "--entitlements",
    "/e1",
    "--identifier",
    "app.freecodez.app",
    "/out/FreeCodeZ.app",
  ]);
  assert.throws(
    () => applyMacAdhocSignIdentifiers(steps, () => {
      throw new Error("codesign blew up");
    }),
    /codesign blew up/,
  );
});

test("discoverHelperBundleNames：只取产品族 Helper*.app，缺失目录返回空", () => {
  const frameworksDir = mkdtempSync(join(tmpdir(), "mac-sign-test-"));
  try {
    mkdirSync(join(frameworksDir, "FreeCodeZ Helper.app"));
    mkdirSync(join(frameworksDir, "FreeCodeZ Helper (GPU).app"));
    mkdirSync(join(frameworksDir, "Electron Framework.framework"));
    mkdirSync(join(frameworksDir, "Other Helper.app"));
    assert.deepEqual(discoverHelperBundleNames(frameworksDir, "FreeCodeZ"), [
      "FreeCodeZ Helper",
      "FreeCodeZ Helper (GPU)",
    ]);
    assert.deepEqual(discoverHelperBundleNames(join(frameworksDir, "missing"), "FreeCodeZ"), []);
  } finally {
    rmSync(frameworksDir, { recursive: true, force: true });
  }
});
