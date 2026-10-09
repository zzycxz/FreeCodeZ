// W-18 可用性判定测试（D2 三平台硬性：含 local-linux）。
import assert from "node:assert/strict";
import test from "node:test";
import { resolveComputerUseAvailability } from "../src/lib/computerUseAvailability.js";

test("本地桌面三平台支持（D2 含 linux），远程与未知平台不支持", () => {
  assert.deepStrictEqual(
    resolveComputerUseAvailability({ isDesktop: true, platform: "darwin" }),
    { supported: true },
  );
  assert.deepStrictEqual(
    resolveComputerUseAvailability({ isDesktop: true, platform: "linux" }),
    { supported: true },
  );
  assert.deepStrictEqual(
    resolveComputerUseAvailability({ isDesktop: true, platform: "win32" }),
    { supported: true },
  );
  assert.deepStrictEqual(resolveComputerUseAvailability({ isDesktop: false }), {
    supported: false,
    reason: "remote",
  });
  assert.deepStrictEqual(
    resolveComputerUseAvailability({ isDesktop: true, platform: "freebsd" }),
    { supported: false, reason: "unsupported-platform" },
  );
});
