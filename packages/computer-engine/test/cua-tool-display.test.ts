// W-30 渲染器输入源投影测试：同构归档形状/错误建议/截图媒体/S6 targetApp。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCuaToolDisplay } from "../src/sdk/cua-tool-display";

describe("渲染器输入源投影（W-30）", () => {
  it("SDK 结果投影为 kind:cua 同构形状（新旧行同链）", () => {
    const display = buildCuaToolDisplay({
      toolName: "get_app_state",
      status: "success",
      result: { treeText: "tree", elementCount: 3 },
      text: "tree",
      screenshot: { mimeType: "image/png", data: "aGk=" },
      targetApp: { displayName: "Finder", bundleId: "com.apple.finder" },
    });
    assert.strictEqual(display.kind, "cua");
    assert.strictEqual(display.schemaVersion, 1);
    assert.strictEqual(display.text, "tree");
    assert.ok(display.structuredContent?.includes("elementCount"));
    assert.deepStrictEqual(display.media, [{ mimeType: "image/png", data: "aGk=" }]);
    assert.deepStrictEqual(display.targetApp?.iconLocators, [
      { kind: "darwin-bundle-id", value: "com.apple.finder" },
    ]);
  });

  it("失败面带 errorCode + 剧本建议（G.2 摘要）", () => {
    const display = buildCuaToolDisplay({
      toolName: "left_click",
      status: "failed",
      errorCode: "ELEMENT_UNAVAILABLE",
    });
    assert.strictEqual(display.status, "failed");
    assert.strictEqual(display.errorCode, "ELEMENT_UNAVAILABLE");
    assert.ok(display.suggestedAction?.includes("re-observe"));
  });
});
