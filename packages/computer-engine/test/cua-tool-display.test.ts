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

describe("P4b 换源：新 SDK 形状投影", () => {
  it("camelCase 方法名归一 snake_case 动词（渲染器词表）", () => {
    assert.strictEqual(buildCuaToolDisplay({ toolName: "getAppState", status: "success" }).toolName, "get_app_state");
    assert.strictEqual(buildCuaToolDisplay({ toolName: "leftClick", status: "success" }).toolName, "left_click");
    assert.strictEqual(buildCuaToolDisplay({ toolName: "elementAtPoint", status: "success" }).toolName, "element_at_point");
  });

  it("params 投影为 display.input，elementIndex 补 target 兼容映射", () => {
    const display = buildCuaToolDisplay({
      toolName: "leftClick",
      status: "success",
      params: { app: "TextEdit", elementIndex: 7 },
    });
    const parsed = JSON.parse(display.input ?? "{}");
    assert.strictEqual(parsed.elementIndex, 7);
    assert.deepStrictEqual(parsed.target, { type: "element", index: 7 });
    // 原键保留（两个形态共存）。
    assert.strictEqual(parsed.app, "TextEdit");
  });

  it("snapshot 内 treeText 进 text；截图从结果抽离进 media 并从结构化内容抹除", () => {
    const display = buildCuaToolDisplay({
      toolName: "getAppState",
      status: "success",
      result: {
        snapshot: { id: "s1", treeText: "App=TextEdit (pid 42)", screenshotPngBase64: "aGVsbG8=" },
      },
    });
    assert.strictEqual(display.text, "App=TextEdit (pid 42)");
    assert.deepStrictEqual(display.media, [{ mimeType: "image/png", data: "aGVsbG8=" }]);
    // base64 不得双携带进 structuredContent。
    assert.ok(!display.structuredContent?.includes("aGVsbG8="));
    assert.ok(display.structuredContent?.includes("treeText"));
  });

  it("dataUrl/mimeType+data 两形态截图同样抽离；超限截图丢弃不炸", () => {
    const a = buildCuaToolDisplay({
      toolName: "screenshot",
      status: "success",
      result: { dataUrl: "data:image/png;base64,aGk=" },
    });
    assert.deepStrictEqual(a.media, [{ mimeType: "image/png", data: "aGk=" }]);
    const b = buildCuaToolDisplay({
      toolName: "getAppState",
      status: "success",
      result: { shot: { mimeType: "image/jpeg", data: "aGk=" } },
    });
    assert.deepStrictEqual(b.media, [{ mimeType: "image/jpeg", data: "aGk=" }]);
    const huge = "x".repeat(400_000);
    const c = buildCuaToolDisplay({
      toolName: "getAppState",
      status: "success",
      result: { snapshot: { treeText: "t", screenshotPngBase64: huge } },
    });
    assert.strictEqual(c.media, undefined);
    assert.ok(!c.structuredContent?.includes(huge.slice(0, 50)));
  });

  it("params 不可序列化时省略 input（宁缺勿错）", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const display = buildCuaToolDisplay({ toolName: "scroll", status: "success", params: cyclic });
    assert.strictEqual(display.input, undefined);
  });
});
