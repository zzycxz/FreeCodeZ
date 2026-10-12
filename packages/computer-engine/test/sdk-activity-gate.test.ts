// W-26 集成断言：动作面套闸（活跃拒绝 user_active 不触达引擎）、观测面不套闸、
// 检测器缺席恒放行。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ComputerUseSdk, type ComputerEngineTransport } from "../src/sdk/computer-use-sdk";
import { ComputerUseSdkError } from "../src/sdk/errors";

function countingTransport(): { transport: ComputerEngineTransport; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    transport: {
      async request(method) {
        calls.push(method);
        return { ok: true, result: { echo: method } };
      },
    },
  };
}

describe("SDK 用户活动闸集成（W-26）", () => {
  it("动作面活跃时拒绝 user_active 且不触达引擎；静默后放行", async () => {
    const { transport, calls } = countingTransport();
    let active = true;
    const sdk = new ComputerUseSdk({
      transport,
      sessionId: "s",
      platform: "darwin",
      readUserActivity: () => ({ userActive: active, lastMoveMs: active ? 5 : 9_000 }),
      activityGate: { thresholdMs: 800, pollMs: 1, maxWaitMs: 5 },
    });
    await assert.rejects(
      sdk.leftClick({ target: { app: "Finder" }, element: { kind: "element", index: 1 } }),
      (error: unknown) => error instanceof ComputerUseSdkError && error.sdkCode === "user_active",
    );
    assert.deepStrictEqual(calls, [], "闸门失败不得触达引擎");
    active = false;
    await sdk.leftClick({ target: { app: "Finder" }, element: { kind: "element", index: 1 } });
    assert.deepStrictEqual(calls, ["click"]);
  });

  it("观测面不套闸；检测器缺席恒放行", async () => {
    const { transport, calls } = countingTransport();
    const sdk = new ComputerUseSdk({
      transport,
      sessionId: "s",
      platform: "darwin",
      readUserActivity: () => ({ userActive: true, lastMoveMs: 5 }),
      activityGate: { thresholdMs: 800, pollMs: 1, maxWaitMs: 5 },
    });
    await sdk.listApps();
    await sdk.getAppState({ app: "Finder" });
    assert.deepStrictEqual(calls, ["listApps", "getAppState"], "观测面不受闸");

    const { transport: t2, calls: c2 } = countingTransport();
    const sdk2 = new ComputerUseSdk({ transport: t2, sessionId: "s", platform: "darwin" });
    await sdk2.paste({ target: { app: "Finder" }, text: "x" });
    assert.deepStrictEqual(c2, ["pasteText"], "检测器缺席时动作面恒放行");
  });

  it("hotkey 公开面（V1.18）：和弦直达引擎 hotkey 方法并套活动闸", async () => {
    const { transport, calls } = countingTransport();
    const sdk = new ComputerUseSdk({
      transport,
      sessionId: "s",
      platform: "darwin",
      readUserActivity: () => ({ userActive: false, lastMoveMs: 9_000 }),
      activityGate: { thresholdMs: 800, pollMs: 1, maxWaitMs: 5 },
    });
    await sdk.hotkey({ target: { app: "Finder" }, key: "CmdOrCtrl+S" });
    assert.deepStrictEqual(calls, ["hotkey"]);
  });

  it("动作层设置门（V1.19 P1）：actionsEnabled=false 拒动作面不触达引擎，观测面豁免", async () => {
    const { transport, calls } = countingTransport();
    const sdk = new ComputerUseSdk({
      transport,
      sessionId: "s",
      platform: "darwin",
      actionsEnabled: false,
    });
    // 观测面豁免（「只能看不能动」）。
    await sdk.listApps();
    await sdk.getAppState({ app: "Finder" });
    await assert.rejects(
      sdk.leftClick({ target: { app: "Finder" }, element: { kind: "element", index: 1 } }),
      (error: unknown) =>
        error instanceof ComputerUseSdkError && error.sdkCode === "actions_disabled",
    );
    await assert.rejects(
      sdk.type({ target: { app: "Finder" }, text: "x" }),
      (error: unknown) =>
        error instanceof ComputerUseSdkError && error.sdkCode === "actions_disabled",
    );
    assert.deepStrictEqual(calls, ["listApps", "getAppState"], "被拒动作不得触达引擎");
  });
});
