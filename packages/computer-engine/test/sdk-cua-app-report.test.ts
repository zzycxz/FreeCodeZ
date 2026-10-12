// V1.19 P4（W-30/S6 重建）回归：观测目标应用身份上报——身份由真实 listApps 快照
// 解析（防模型自报伪造），getAppState 时上报、同 pid 去重、回调异常不折断观测。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ComputerUseSdk, type ComputerEngineTransport } from "../src/sdk/computer-use-sdk";

function transportWith(apps: Array<{ pid: number; name: string; bundleId?: string }>): ComputerEngineTransport {
  return {
    async request(method: string) {
      if (method === "listApps") return { ok: true, result: { apps } };
      if (method === "getAppState") {
        return { ok: true, result: { snapshot: { id: "s", treeText: "App=x", focusedElementId: null } } };
      }
      return { ok: true, result: {} };
    },
  };
}

describe("onCuaApp（V1.19 P4）", () => {
  it("listApps 先行 → getAppState 上报解析出的真实身份；同 pid 去重", async () => {
    const reported: Array<{ pid: number; name: string }> = [];
    const sdk = new ComputerUseSdk({
      transport: transportWith([{ pid: 123, name: "计算器", bundleId: "com.apple.calculator" }]),
      sessionId: "s",
      platform: "darwin",
      onCuaApp: (app) => reported.push(app),
    });
    await sdk.listApps();
    await sdk.getAppState({ app: "com.apple.calculator" });
    await sdk.getAppState({ app: "com.apple.calculator" }); // 同 app 第二次：去重
    assert.deepEqual(reported, [{ pid: 123, name: "计算器", bundleId: "com.apple.calculator" }]);
  });

  it("快照未建（未 listApps）不上报；回调抛错不折断观测", async () => {
    let calls = 0;
    const sdk = new ComputerUseSdk({
      transport: transportWith([{ pid: 1, name: "X" }]),
      sessionId: "s",
      platform: "darwin",
      onCuaApp: () => {
        calls += 1;
        throw new Error("report sink down");
      },
    });
    await sdk.getAppState({ app: "X" }); // 无快照：不上报
    assert.equal(calls, 0);
    await sdk.listApps();
    const state = await sdk.getAppState({ app: "X" }); // 回调抛错但观测成功
    assert.ok((state as { snapshot: { treeText: string } }).snapshot.treeText === "App=x");
    assert.equal(calls, 1);
  });
});
