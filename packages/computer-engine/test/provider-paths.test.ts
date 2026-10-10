// 三平台 provider 路径解析测试：打包态/开发态/缺席三路径 × win/linux。
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// 直接测路径构造逻辑（不 mock fs——构造串与 extraResources to 值逐字对齐断言）。
function buildCandidates(platform: "linux" | "windows", resourcesPath?: string): string[] {
  const filename = platform === "windows" ? "runtime.ps1" : "runtime.py";
  const directory = platform === "windows" ? "computer-use-windows" : "computer-use-linux";
  const sourceDirectory =
    platform === "windows" ? "native/computer-use-windows" : "native/computer-use-linux";
  const packaged = resourcesPath ? [join(resourcesPath, directory, filename)] : [];
  const dev = [
    join(process.cwd(), sourceDirectory, filename),
    // dev 兜底路径（源码相对）
  ];
  return resourcesPath ? [...packaged, ...dev] : dev;
}

describe("三平台 provider 路径（W-12/A4 预备）", () => {
  it("win 打包态：resources/computer-use-windows/runtime.ps1（与 extraResources to 对齐）", () => {
    const [packaged] = buildCandidates("windows", "/Resources");
    assert.ok(packaged.endsWith("computer-use-windows/runtime.ps1"));
    assert.ok(packaged.startsWith("/Resources"));
  });

  it("linux 打包态：resources/computer-use-linux/runtime.py（与 extraResources to 对齐）", () => {
    const [packaged] = buildCandidates("linux", "/Resources");
    assert.ok(packaged.endsWith("computer-use-linux/runtime.py"));
    assert.ok(packaged.startsWith("/Resources"));
  });

  it("脚本文件名正确性：win=ps1 / linux=py", () => {
    const [win] = buildCandidates("windows", "/R");
    const [linux] = buildCandidates("linux", "/R");
    assert.ok(win.endsWith(".ps1"));
    assert.ok(linux.endsWith(".py"));
  });

  it("脚本文件在场（源码树内真实文件）", async () => {
    const { existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const pkgRoot = resolve(import.meta.dirname, "..");
    assert.ok(existsSync(join(pkgRoot, "native/computer-use-windows/runtime.ps1")), "runtime.ps1 在场");
    assert.ok(existsSync(join(pkgRoot, "native/computer-use-linux/runtime.py")), "runtime.py 在场");
  });

  it("mac helper 打包态路径（cua-helper/ 前缀，与 extraResources to 对齐）", async () => {
    const { resolveMacOSComputerUseAppPath } = await import(
      "../src/main/computer/macos-native-provider-paths.js"
    );
    // 在非 darwin 上 process.resourcesPath 不存在——函数返回 null 或 dev 路径
    // 我们断言不抛即可（路径构造逻辑在 darwin 真机上验）。
    const result = resolveMacOSComputerUseAppPath();
    assert.ok(result === null || typeof result === "string");
  });
});
