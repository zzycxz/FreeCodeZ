// W-30 cuaApp 投影测试：pid 精确命中/bundleId 唯一匹配/多进程不猜/S6 形状。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCuaAppSnapshot,
  resolveCuaAppIdentity,
} from "../src/sdk/cua-app-projection";
import { ComputerUseSdk, type ComputerEngineTransport } from "../src/sdk/computer-use-sdk";

describe("cuaApp 身份投影（W-30）", () => {
  const snapshot = buildCuaAppSnapshot([
    { pid: 100, name: "Finder", bundleId: "com.apple.finder" },
    { pid: 200, name: "Safari", bundleId: "com.apple.Safari" },
    { pid: 201, name: "Safari", bundleId: "com.apple.Safari" },
    { pid: -1, name: "bad" },
    { pid: 300, name: "" },
  ]);

  it("快照建索引：非法 pid/name 剔除，S6 形状 {pid,name,bundleId?}", () => {
    assert.strictEqual(snapshot.size, 3);
    assert.deepStrictEqual(snapshot.get(100), {
      pid: 100,
      name: "Finder",
      bundleId: "com.apple.finder",
    });
  });

  it("pid 精确命中优先；bundleId 唯一匹配；多进程同 bundle 不猜测", () => {
    assert.strictEqual(
      resolveCuaAppIdentity({ app_ref: { pid: 200 } }, snapshot)?.name,
      "Safari",
    );
    assert.strictEqual(
      resolveCuaAppIdentity({ app_ref: { bundleId: "com.apple.finder" } }, snapshot)?.pid,
      100,
    );
    assert.strictEqual(
      resolveCuaAppIdentity({ app_ref: { bundleId: "com.apple.Safari" } }, snapshot),
      undefined,
    );
  });

  it("SDK listApps 缓存 + cuaAppFor 解析", async () => {
    const transport: ComputerEngineTransport = {
      async request() {
        return {
          ok: true,
          result: { apps: [{ pid: 7, name: "Music", bundleId: "com.apple.Music" }] },
        };
      },
    };
    const sdk = new ComputerUseSdk({ transport, sessionId: "s", platform: "darwin" });
    await sdk.listApps();
    assert.strictEqual(sdk.cuaAppFor({ app_ref: { pid: 7 } })?.name, "Music");
  });
});
