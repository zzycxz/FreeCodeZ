// G2（2026-10-11 装机审计）回归：macOS helper dev 候选必须覆盖三种产物深度。
// 同一份引擎源码会被打进：源码 tsx（src/main/computer/）、sidecar esbuild 产物（dist/）、
// desktop main tsup 产物（out/main/）——打包后 import.meta.dirname 变浅，原先只有源码
// 深度一条相对候选导致 dev 态 helper 全落空。
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { macOSHelperAppDevCandidates } from "../src/main/computer/macos-native-provider-paths.js";

const TAIL = "native/computer-use-macos/.build/release/FreeCodeZ Computer Use.app";

describe("macOS helper dev 候选三深度（G2 回归）", () => {
  it("sidecar esbuild 产物深度：dist/ 上1层=包根命中", () => {
    const fromSidecarBundle = macOSHelperAppDevCandidates(
      "/repo/packages/computer-engine/dist",
    );
    assert.ok(
      fromSidecarBundle.includes(resolve("/repo/packages/computer-engine", TAIL)),
      `sidecar bundle 候选应含包根路径: ${fromSidecarBundle.join(", ")}`,
    );
  });

  it("源码深度：src/main/computer/ 上3层=包根命中（修正原实现的上2层错层）", () => {
    const fromSource = macOSHelperAppDevCandidates(
      "/repo/packages/computer-engine/src/main/computer",
    );
    assert.ok(
      fromSource.includes(resolve("/repo/packages/computer-engine", TAIL)),
      `源码候选应含包根路径: ${fromSource.join(", ")}`,
    );
  });

  it("desktop main tsup 产物深度：out/main/ 上3层入 computer-engine 命中", () => {
    const fromDesktopMain = macOSHelperAppDevCandidates("/repo/packages/desktop/out/main");
    assert.ok(
      fromDesktopMain.includes(resolve("/repo/packages", "computer-engine", TAIL)),
      `desktop main 候选应含 packages 下路径: ${fromDesktopMain.join(", ")}`,
    );
  });
});
