// FreeCodeZ W-13 权限面冒烟：permissions/permissionsStatus 暴露面在位。
// 探测在无 helper 环境返回结构化 unavailable 结果（不抛裸错）；reset 依赖 tccutil
// 且会撤销 TCC 授权——只验 API 在位与返回形状，不在 CI 真跑（装机手动验证）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getComputerUsePermissionStatus,
  openComputerUsePermissions,
  resetComputerUsePermissions,
} from "../src/main/computer/macos-computer-use-permissions";

describe("computer use permissions surface (W-13)", () => {
  it("permissionsStatus 探测返回结构化结果（无 helper 时降级不抛）", async () => {
    const result = await getComputerUsePermissionStatus();
    assert.strictEqual(typeof result.platform, "string");
    assert.ok(Array.isArray(result.permissions));
    for (const entry of result.permissions) {
      assert.ok(
        ["accessibility", "screenshots"].includes(entry.id),
        `unexpected permission id: ${entry.id}`,
      );
      assert.strictEqual(typeof entry.status, "string");
    }
    if (result.helperAppPath === null) {
      assert.strictEqual(typeof result.helperUnavailableReason, "string");
    }
  });

  it("permissions 开放/重置 API 在位（reset 不在 CI 真跑）", () => {
    assert.strictEqual(typeof openComputerUsePermissions, "function");
    assert.strictEqual(typeof resetComputerUsePermissions, "function");
  });
});
