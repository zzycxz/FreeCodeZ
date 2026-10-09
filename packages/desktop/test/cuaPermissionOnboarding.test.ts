// R21 主应用录屏自注册（权限引导面）测试：
// ① screen_recording stage 打开设置页前请求一次、accessibility stage 不请求；
// ② 请求抛错不阻断引导（设置页照常打开、success 照常返回）。
// 假 helper 束用临时空目录：指纹函数对缺失条目宽容（stat 失败折 MISSING），前后一致即可过验。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CuaPermissionKind } from "@zcode/shared";
import { openCuaPermissionOnboarding } from "../src/main/cuaAccessibilitySettings.js";

function createFakeHelperBundle(): string {
  return mkdtempSync(join(tmpdir(), "cua-onboarding-test-"));
}

function fakeIdentity(appPath: string) {
  return {
    appPath,
    executablePath: join(appPath, "Contents", "MacOS", "FreeCodeZ Computer Use"),
    displayName: "FreeCodeZ Computer Use",
    bundleId: "app.freecodez.cua-helper",
  };
}

test("R21：screen_recording stage 打开设置页前自注册；accessibility stage 不请求", async () => {
  const appPath = createFakeHelperBundle();
  const order: string[] = [];
  try {
    const result = await openCuaPermissionOnboarding({
      platform: "darwin",
      requiredPermissions: ["accessibility", "screen_recording"] as CuaPermissionKind[],
      ensureHelperInstalled: async () => appPath,
      verifyHelperInstalled: async () => {},
      resolveHelperIdentity: async () => fakeIdentity(appPath),
      requestMainScreenRecordingAccess: () => {
        order.push("request");
        return true;
      },
      openSettingsUrl: async (url: string) => {
        order.push(url.includes("ScreenCapture") ? "url:screen" : "url:accessibility");
      },
      openSettingsAndWaitForReturn: async ({ openSettings }) => {
        await openSettings();
      },
    });
    assert.equal(result.success, true, result.error ?? "");
    assert.deepEqual(
      order,
      ["url:accessibility", "request", "url:screen"],
      "录屏 stage 请求恰好一次且先于打开设置页；辅助功能 stage 不请求",
    );
  } finally {
    rmSync(appPath, { recursive: true, force: true });
  }
});

test("R21：自注册请求抛错不阻断引导（warn 后照常打开设置页）", async () => {
  const appPath = createFakeHelperBundle();
  const order: string[] = [];
  const warnings: string[] = [];
  try {
    const result = await openCuaPermissionOnboarding({
      platform: "darwin",
      requiredPermissions: ["screen_recording"] as CuaPermissionKind[],
      ensureHelperInstalled: async () => appPath,
      verifyHelperInstalled: async () => {},
      resolveHelperIdentity: async () => fakeIdentity(appPath),
      requestMainScreenRecordingAccess: () => {
        throw new Error("koffi unavailable");
      },
      openSettingsUrl: async (url: string) => {
        order.push(url.includes("ScreenCapture") ? "url:screen" : "url:accessibility");
      },
      openSettingsAndWaitForReturn: async ({ openSettings }) => {
        await openSettings();
      },
      logger: {
        warn: (message: unknown) => warnings.push(String(message)),
      },
    });
    assert.equal(result.success, true, result.error ?? "");
    assert.deepEqual(order, ["url:screen"], "请求失败仍打开录屏设置页");
    assert.ok(warnings.some((message) => message.includes("self-registration")), "失败记 warn");
  } finally {
    rmSync(appPath, { recursive: true, force: true });
  }
});
