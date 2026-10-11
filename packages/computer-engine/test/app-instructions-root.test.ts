// G3（2026-10-11 装机审计）回归：app-instructions 根可运行时重定位 + 缺席静默降级。
// SDK 被 esbuild 内联进 node_repl server bundle 后源码相对根（src/sdk/ → 上2层）失效，
// ComputerUseSdk 构造面用 docsRoot 覆盖（桥面从 sidecar 产物目录推导）。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  appInstructionsRoot,
  loadAppInstructions,
  setAppInstructionsRoot,
} from "../src/sdk/app-instructions.js";

const originalRoot = appInstructionsRoot();
afterEach(() => {
  setAppInstructionsRoot(originalRoot);
});

describe("app-instructions 根重定位（G3 回归）", () => {
  it("setAppInstructionsRoot 后从新根装载并清缓存", () => {
    const dir = mkdtempSync(join(tmpdir(), "app-instructions-root-"));
    try {
      writeFileSync(join(dir, "com.apple.Safari.md"), "fake safari instructions");
      setAppInstructionsRoot(dir);
      assert.equal(appInstructionsRoot(), dir);
      assert.equal(loadAppInstructions({ name: "Safari" }), "fake safari instructions");
      // bundleId 直查路径同样走新根
      assert.equal(
        loadAppInstructions({ bundleId: "com.apple.Safari" }),
        "fake safari instructions",
      );
      // 未命中别名/文件：返回 undefined 不炸
      assert.equal(loadAppInstructions({ name: "unknown-app" }), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("根缺席/文件缺失静默降级返回 undefined（不炸）", () => {
    const dir = mkdtempSync(join(tmpdir(), "app-instructions-missing-"));
    try {
      setAppInstructionsRoot(dir);
      assert.equal(loadAppInstructions({ bundleId: "com.apple.Safari" }), undefined);
      assert.equal(loadAppInstructions({ name: "safari" }), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
