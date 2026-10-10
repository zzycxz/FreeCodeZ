// W-18 可用性判定测试（D2 三平台硬性：含 local-linux）。
import assert from "node:assert/strict";
import test from "node:test";
import { resolveComputerUseAvailability } from "../src/lib/computerUseAvailability.js";

test("本地桌面全支持（D2 三平台硬性），远程不支持", () => {
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
  // D2 三平台硬性后：本地桌面全支持（含未知 OS 枚举），仅远程不支持。
  assert.deepStrictEqual(
    resolveComputerUseAvailability({ isDesktop: true, platform: "freebsd" }),
    { supported: true },
  );
});
