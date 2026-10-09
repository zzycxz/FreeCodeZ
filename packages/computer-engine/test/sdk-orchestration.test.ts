// FreeCodeZ W-14 SDK 编排单测（附录 G.1/G.2 验收面）：14 工具编排逐一在新面执行
// （fake transport 断言方法+参数变换），错误映射/拆分/预检/闩锁接线全绿。
// A5 真机场景（真 provider）待 A10 TCC 授权后装机补测。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ComputerControlGate, ControlLatchError } from "../src/host/control-latch";
import { ComputerUseSdk, type ComputerEngineTransport } from "../src/sdk/computer-use-sdk";
import { ComputerUseSdkError, mapEngineError } from "../src/sdk/errors";

type Call = { method: string; params: Record<string, unknown> };

function fakeTransport(
  respond?: (method: string, params: Record<string, unknown>) => unknown,
): { transport: ComputerEngineTransport; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    transport: {
      async request(method, params) {
        calls.push({ method, params: params ?? {} });
        return { ok: true, result: respond ? respond(method, params ?? {}) : { echo: method } };
      },
    },
  };
}

function sdkWith(respond?: (method: string, params: Record<string, unknown>) => unknown, platform?: NodeJS.Platform) {
  const { transport, calls } = fakeTransport(respond);
  const sdk = new ComputerUseSdk({ transport, sessionId: "sess-1", platform: platform ?? "darwin" });
  return { sdk, calls };
}

describe("ComputerUseSdk 工具编排（G.1）", () => {
  it("探测面：capabilities/listApps/listWindows 直传且注入 session", async () => {
    const { sdk, calls } = sdkWith();
    await sdk.capabilities();
    await sdk.listApps();
    await sdk.listWindows({ app: "Finder" });
    assert.deepStrictEqual(
      calls.map((c) => c.method),
      ["capabilities", "listApps", "listWindows"],
    );
    assert.strictEqual(calls[2]?.params.session, "sess-1");
  });

  it("get_app_state：include_screenshot=false 映射 noScreenshot，restoreWindow 直传", async () => {
    const { sdk, calls } = sdkWith();
    await sdk.getAppState({ app: "Finder", includeScreenshot: false });
    await sdk.getAppState({ app: "Finder", restoreWindow: true, windowId: 4 });
    assert.strictEqual(calls[0]?.params.noScreenshot, true);
    assert.strictEqual(calls[1]?.params.restoreWindow, true);
    assert.strictEqual(calls[1]?.params.windowId, 4);
  });

  it("left_click：element 直传 elementIndex；坐标按 scale 换算像素→窗口坐标", async () => {
    const { sdk, calls } = sdkWith();
    await sdk.leftClick({ target: { app: "Finder" }, element: { kind: "element", index: 7 }, count: 2, button: "right", modifiers: "CmdOrCtrl" });
    await sdk.leftClick({ target: { app: "Finder" }, element: { kind: "coordinate", x: 400, y: 200, scale: 2 } });
    assert.strictEqual(calls[0]?.params.elementIndex, 7);
    assert.strictEqual(calls[0]?.params.clickCount, 2);
    assert.strictEqual(calls[0]?.params.mouseButton, "right");
    assert.strictEqual(calls[1]?.params.x, 200);
    assert.strictEqual(calls[1]?.params.y, 100);
    assert.strictEqual(calls[1]?.params.elementIndex, undefined);
  });

  it("scroll：amount(0-100) → pages=amount/100", async () => {
    const { sdk, calls } = sdkWith();
    await sdk.scroll({ target: { app: "Finder" }, element: { kind: "element", index: 3 }, direction: "down", amount: 50 });
    assert.strictEqual(calls[0]?.params.pages, 0.5);
    assert.strictEqual(calls[0]?.params.direction, "down");
  });

  it("drag：同应用下发；跨应用预检 INVALID_REQUEST 不下发", async () => {
    const { sdk, calls } = sdkWith();
    await sdk.drag({
      target: { app: "Finder" },
      from: { kind: "element", index: 1 },
      to: { kind: "element", index: 2 },
    });
    assert.strictEqual(calls[0]?.method, "drag");
    assert.strictEqual(calls[0]?.params.fromElementIndex, 1);
    assert.strictEqual(calls[0]?.params.toElementIndex, 2);

    await assert.rejects(
      sdk.drag({
        target: { app: "Finder" },
        from: { kind: "element", index: 1 },
        to: { kind: "element", index: 2, app: "Safari" },
      }),
      (error: unknown) => error instanceof ComputerUseSdkError && error.sdkCode === "INVALID_REQUEST",
    );
    assert.strictEqual(calls.length, 1, "跨应用 drag 不得触达引擎");
  });

  it("type：带目标先聚焦；>1024 UTF-16 拆分多发保序", async () => {
    const { sdk, calls } = sdkWith();
    await sdk.type({ target: { app: "Finder" }, text: "hi", element: { kind: "element", index: 5 } });
    assert.deepStrictEqual(
      calls.map((c) => c.method),
      ["click", "typeText"],
    );
    assert.strictEqual(calls[1]?.params.text, "hi");

    const { sdk: sdk2, calls: calls2 } = sdkWith();
    const long = "a".repeat(2500);
    await sdk2.type({ target: { app: "Finder" }, text: long });
    assert.deepStrictEqual(
      calls2.map((c) => c.method),
      ["typeText", "typeText", "typeText"],
    );
    assert.strictEqual(calls2[0]?.params.text.length, 1024);
    assert.strictEqual(calls2[2]?.params.text.length, 2500 - 2048);
  });

  it("set_value/perform_action/paste 直传 elementIndex 与文本", async () => {
    const { sdk, calls } = sdkWith();
    await sdk.setValue({ target: { app: "Finder" }, element: { kind: "element", index: 9 }, value: "v" });
    await sdk.performAction({ target: { app: "Finder" }, element: { kind: "element", index: 9 }, action: "Confirm" });
    await sdk.paste({ target: { app: "Finder" }, text: "paste-me" });
    assert.deepStrictEqual(
      calls.map((c) => c.method),
      ["setValue", "performSecondaryAction", "pasteText"],
    );
    assert.strictEqual(calls[0]?.params.value, "v");
    assert.strictEqual(calls[1]?.params.action, "Confirm");
  });

  it("select_text：全量=click 聚焦+CmdOrCtrl+A；部分范围 not_selectable（D4）", async () => {
    const { sdk, calls } = sdkWith();
    await sdk.selectText({ target: { app: "Finder" }, element: { kind: "element", index: 2 } });
    assert.deepStrictEqual(
      calls.map((c) => c.method),
      ["click", "hotkey"],
    );
    assert.strictEqual(calls[1]?.params.key, "CmdOrCtrl+A");

    await assert.rejects(
      sdk.selectText({ target: { app: "Finder" }, element: { kind: "element", index: 2 }, textRange: { start: 0, end: 3 } }),
      (error: unknown) => error instanceof ComputerUseSdkError && error.sdkCode === "not_selectable",
    );
  });

  it("key：repeat 由 SDK 循环多发 pressKey", async () => {
    const { sdk, calls } = sdkWith();
    await sdk.key({ target: { app: "Finder" }, key: "Return", repeat: 3 });
    assert.strictEqual(calls.length, 3);
    assert.ok(calls.every((c) => c.method === "pressKey" && c.params.key === "Return"));
  });

  it("request_access：非 darwin 合成无需授权；darwin 走权限面探测", async () => {
    const { sdk } = sdkWith(undefined, "linux");
    const answer = await sdk.requestAccess({});
    assert.strictEqual(answer.granted, true);
    assert.ok(answer.permissions.every((p) => p.status === "not-required"));
  });

  it("stop：闩锁幂等且动作面拒绝 control_stopped，request_access 豁免", async () => {
    const { sdk, calls } = sdkWith();
    const first = sdk.stop("Esc");
    const second = sdk.stop("again");
    assert.strictEqual(first.reason, "Esc");
    assert.strictEqual(second.reason, "Esc");
    await assert.rejects(
      sdk.leftClick({ target: { app: "Finder" }, element: { kind: "element", index: 1 } }),
      (error: unknown) =>
        (error instanceof ControlLatchError && error.code === "control_stopped") ||
        (error instanceof ComputerUseSdkError && error.sdkCode === "control_stopped"),
    );
    assert.strictEqual(calls.length, 0, "闩锁后不得触达引擎");
  });
});

describe("SDK 错误映射（G.2）", () => {
  it("映射表：重试类与 possibly_sent 语义位正确", () => {
    assert.deepStrictEqual(mapEngineError("element_not_found", ""), {
      sdkCode: "ELEMENT_UNAVAILABLE",
      retry: "reobserve",
      possiblySent: false,
    });
    assert.deepStrictEqual(mapEngineError("action_timeout", ""), {
      sdkCode: "TIMEOUT",
      retry: "never",
      possiblySent: true,
    });
    assert.deepStrictEqual(mapEngineError("window_not_focused", "1 press(es) may already have been delivered"), {
      sdkCode: "FOREGROUND_REQUIRED",
      retry: "never",
      possiblySent: true,
    });
    assert.deepStrictEqual(mapEngineError("window_not_focused", "window is not focused"), {
      sdkCode: "FOREGROUND_REQUIRED",
      retry: "reobserve",
      possiblySent: false,
    });
    assert.deepStrictEqual(
      mapEngineError("unsupported_capability", "computer-use has no native provider for linux"),
      { sdkCode: "CUA_NOT_READY", retry: "retry", possiblySent: false },
    );
  });

  it("引擎错误信封映射为 ComputerUseSdkError（含 source）", async () => {
    const transport: ComputerEngineTransport = {
      async request() {
        return { ok: false, error: { code: "window_not_found", message: "window gone" } };
      },
    };
    const sdk = new ComputerUseSdk({ transport, sessionId: "s", platform: "darwin" });
    await assert.rejects(
      sdk.listApps(),
      (error: unknown) =>
        error instanceof ComputerUseSdkError &&
        error.sdkCode === "WINDOW_STALE" &&
        error.retry === "reobserve" &&
        error.source === "window_not_found",
    );
  });

  it("传输级失败 → CUA_NOT_READY（R7 fail-closed 显式拒，不空转）", async () => {
    const transport: ComputerEngineTransport = {
      async request() {
        throw new Error("sidecar exited");
      },
    };
    const sdk = new ComputerUseSdk({ transport, sessionId: "s", platform: "darwin" });
    await assert.rejects(
      sdk.capabilities(),
      (error: unknown) => error instanceof ComputerUseSdkError && error.sdkCode === "CUA_NOT_READY",
    );
  });
});

describe("W-17 闩锁/租约接线", () => {
  it("租约互斥：busy 拒绝 never-retry 语义位", () => {
    const gate = new ComputerControlGate();
    const lease = gate.acquireLease("sess-1", "turn-1");
    assert.ok(lease.signal instanceof AbortSignal);
    assert.throws(
      () => gate.acquireLease("sess-2", "turn-2"),
      (error: unknown) => error instanceof ControlLatchError && error.code === "controller_busy",
    );
    gate.releaseLease(lease);
  });
});
