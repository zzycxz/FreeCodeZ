// W-27 注入测试：bundle id/名匹配、未命中缺席、SDK get_app_state 注入形状。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadAppInstructions } from "../src/sdk/app-instructions";
import { ComputerUseSdk, type ComputerEngineTransport } from "../src/sdk/computer-use-sdk";

describe("app-instructions 注入（W-27）", () => {
  it("bundle id 与应用名（大小写不敏感）均命中；未命中缺席", () => {
    assert.ok(loadAppInstructions({ bundleId: "com.apple.Safari" })?.includes("Safari"));
    assert.ok(loadAppInstructions({ name: "safari" })?.includes("address bar"));
    assert.ok(loadAppInstructions({ name: "SPOTIFY" })?.includes("Spotify"));
    assert.ok(loadAppInstructions({ bundleId: "com.unknown.app" }) === undefined);
    assert.ok(loadAppInstructions({ name: "Unknown App" }) === undefined);
  });

  it("十件资产全部可加载且为非空文本", () => {
    for (const key of [
      "com.apple.Safari", "com.apple.finder", "com.microsoft.VSCode",
      "com.apple.Music", "com.apple.clock", "com.apple.iWork.Numbers",
      "com.spotify.client", "com.tinyspeck.slackmacgap", "notion.id",
      "com.apple.ScreenContinuity",
    ]) {
      const text = loadAppInstructions({ bundleId: key });
      assert.ok(text && text.length > 40, `${key} 资产缺失`);
    }
  });

  it("SDK get_app_state 注入 appInstructions；未命中应用不注入", async () => {
    const calls: string[] = [];
    const transport: ComputerEngineTransport = {
      async request(method) {
        calls.push(method);
        return { ok: true, result: { id: "snap-1", treeText: "tree" } };
      },
    };
    const sdk = new ComputerUseSdk({ transport, sessionId: "s", platform: "darwin" });
    const injected = (await sdk.getAppState({ app: "Finder" })) as Record<string, unknown>;
    assert.strictEqual(injected.id, "snap-1");
    assert.ok(String(injected.appInstructions).includes("Finder"));
    const bare = (await sdk.getAppState({ app: "UnknownTool" })) as Record<string, unknown>;
    assert.strictEqual(bare.appInstructions, undefined);
  });
});
