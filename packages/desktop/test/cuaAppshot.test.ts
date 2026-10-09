// Phase 3a（升级实施手册 桌面控制 Appshot）测试：
// ① 双击状态机（纯）：两击触发/超窗回落/三击静默/持续按住不触发；
// ② 前台窗口选择（纯）：layer 过滤/尺寸下限/排除 pid/前到后序；
// ③ desktop 装配（注入式）：默认 off no-op、热键触发→快照→定向派发事件、
//    devtools 窗口不打扰、快照失败留日志不抛。
import assert from "node:assert/strict";
import test from "node:test";
import { nextDoubleTapState, pickFrontmostAppWindow } from "@zcode/zcode-cua/macos";
import { startCuaAppshot, resolveAppshotHotkeySetting, APPSHOT_ADD_TO_CHAT_EVENT } from "../src/main/cuaAppshot.js";

test("双击状态机：两次完整按下-抬起触发；超窗回落；静默期防三击", () => {
  let state;
  const step = (down: boolean, now: number) => {
    const result = nextDoubleTapState(state, down, now);
    state = result.state;
    return result.triggered;
  };
  // 第一击
  assert.equal(step(true, 0), false);
  assert.equal(step(false, 100), false);
  assert.equal(state.phase, "armed");
  // 第二击（窗口内）
  assert.equal(step(true, 300), false);
  assert.equal(step(false, 400), true, "两击完整间隔 300ms 内触发");
  assert.equal(state.phase, "refractory");
  // 静默期内第三击不触发
  assert.equal(step(true, 500), false);
  assert.equal(step(false, 600), false);
  // 静默期过后恢复
  assert.equal(step(true, 1300), false);
  assert.equal(step(false, 1400), false);
  assert.equal(state.phase, "armed");
  // 超窗的第二击重置 armed 而不是触发
  assert.equal(step(true, 2500), false);
  assert.equal(step(false, 2600), false, "间隔 1200ms 超窗不触发");
  assert.equal(state.phase, "armed");
});

test("双击状态机：持续按住（无抬起沿）不触发", () => {
  let state;
  for (const now of [0, 30, 60, 90, 500, 600]) {
    const result = nextDoubleTapState(state, true, now);
    state = result.state;
    assert.equal(result.triggered, false);
  }
  // 单次抬起后长时间不动 → 回落 idle
  const released = nextDoubleTapState(state, false, 700);
  state = released.state;
  assert.equal(released.triggered, false);
  const after = nextDoubleTapState(state, false, 5000);
  assert.equal(after.state.phase, "idle");
});

test("前台窗口选择：layer0+尺寸达标+排除 pid，前到后取第一个", () => {
  const windows = [
    { windowId: 1, pid: 10, layer: -2147483625, ownerName: "Wallpaper", bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    { windowId: 2, pid: 11, layer: 0, ownerName: "CursorUI", bounds: { x: 100, y: 100, width: 20, height: 24 } },
    { windowId: 3, pid: 12, layer: 0, ownerName: "Self", bounds: { x: 0, y: 0, width: 800, height: 600 } },
    { windowId: 4, pid: 13, layer: 0, ownerName: "Safari", bounds: { x: 0, y: 25, width: 1920, height: 1030 } },
    { windowId: 5, pid: 14, layer: 0, ownerName: "NoBoundsApp" },
  ];
  assert.equal(pickFrontmostAppWindow(windows, { excludePids: [12] })?.windowId, 4);
  // 不排除 self 时 self（前到后更靠前）胜出
  assert.equal(pickFrontmostAppWindow(windows, {})?.windowId, 3);
  assert.equal(pickFrontmostAppWindow([]), undefined);
});

test("desktop 装配：默认 off → no-op；非法值 → off", () => {
  assert.equal(resolveAppshotHotkeySetting(undefined), "off");
  assert.equal(resolveAppshotHotkeySetting("bogus"), "off");
  assert.equal(resolveAppshotHotkeySetting("cmd"), "cmd");
  const controller = startCuaAppshot({
    getFocusedWindow: () => undefined,
    env: {},
  });
  assert.equal(controller.enabled, false);
  controller.stop();
});

test("desktop 装配：热键触发 → 快照 → 聚焦窗口定向派发 CustomEvent", async () => {
  const executed: string[] = [];
  const logs: string[] = [];
  let trigger: (() => void) | undefined;
  // 用假的 watcher 注入不行（startCuaAppshot 内部创建）——经 platform 注入非 darwin
  // 也不行（直接 no-op）。改测 triggerAppshot 等价路径：直接构造 controller 并手动
  // 复现触发逻辑（runSnapshot 注入版）。
  const controller = startCuaAppshot({
    getFocusedWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        getURL: () => "file:///app/index.html",
        executeJavaScript: async (code: string) => {
          executed.push(code);
        },
      },
    }),
    env: { FREECODEZ_APPSHOT_HOTKEY: "cmd" },
    platform: "darwin",
    // koffi 在测试进程可用（root node_modules），watcher 会真轮询 cmd 键——
    // 由用例内直接驱动 runSnapshot 验证派发路径，不依赖真实双击。
    runSnapshot: async () => ({
      ok: true as const,
      app: { pid: 42, name: "Safari" },
      windowId: 7,
      capture: { path: "/tmp/appshot-7.png", bytes: 1024 },
      axTree: { elementCount: 120 },
    }),
    log: (message) => logs.push(message),
  });
  assert.equal(typeof controller.stop, "function");
  // 手动触发通道（与热击同路径）：快照 → 聚焦窗口派发 CustomEvent。
  controller.trigger();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(executed.length, 1, "快照结果恰好派发一次");
  assert.ok(executed[0]?.includes(APPSHOT_ADD_TO_CHAT_EVENT));
  assert.ok(executed[0]?.includes("appshot-7.png"));
  assert.ok(logs.some((message) => message.includes("delivered")));
  controller.stop();
});

test("设置面：设置键优先于 env；音效/路由透传", async () => {
  let played = 0;
  let settings: { appshotHotkey?: string; appshotSound?: boolean; appshotRoute?: string } = {
    appshotHotkey: "cmd",
  };
  const executed: string[] = [];
  const controller = startCuaAppshot({
    getFocusedWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        getURL: () => "file:///app/index.html",
        executeJavaScript: async (code: string) => {
          executed.push(code);
        },
      },
    }),
    env: {}, // env 未设置
    platform: "darwin",
    getAppshotSettings: () => settings,
    playSound: () => {
      played += 1;
    },
    runSnapshot: async () => ({
      ok: true as const,
      app: { pid: 1, name: "Test" },
      windowId: 3,
      capture: { path: "/tmp/t.png", bytes: 5 },
      axTree: { elementCount: 2 },
    }),
    log: () => {},
  });
  controller.trigger();
  for (let i = 0; i < 20 && executed.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(executed.length, 1, "设置键 cmd 激活（env 空时）");
  assert.ok(executed[0]?.includes("freecodez:appshot-add-to-chat"));
  assert.ok(executed[0]?.includes('"route":"current"'), "缺省路由=current");
  assert.equal(played, 1, "音效触发");

  // 路由 new + 音效关
  executed.length = 0;
  played = 0;
  settings = { appshotHotkey: "cmd", appshotRoute: "new", appshotSound: false };
  controller.trigger();
  for (let i = 0; i < 20 && executed.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(executed[0]?.includes('"route":"new"'), "路由 new 透传");
  assert.equal(played, 0, "音效关不响");

  // 设置 off → 不触发（env 有值也不行）
  executed.length = 0;
  controller.stop();
  const off = startCuaAppshot({
    getFocusedWindow: () => ({
      isDestroyed: () => false,
      webContents: { getURL: () => "file:///x", executeJavaScript: async () => undefined },
    }),
    env: { FREECODEZ_APPSHOT_HOTKEY: "cmd" },
    platform: "darwin",
    getAppshotSettings: () => ({ appshotHotkey: "off" }),
    runSnapshot: async () => ({ ok: true, app: { pid: 1, name: "x" }, windowId: 1, axTree: {} }),
    log: () => {},
  });
  off.trigger();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(executed.length, 0, "设置 off 覆盖 env cmd");
  off.stop();
});

test("R21 录屏自注册：预检未授权 → 请求先于快照；已授权不请求", async () => {
  const order: string[] = [];
  const run = async (screenGranted: boolean) => {
    const executed: string[] = [];
    const controller = startCuaAppshot({
      getFocusedWindow: () => ({
        isDestroyed: () => false,
        webContents: {
          getURL: () => "file:///app/index.html",
          executeJavaScript: async (code: string) => {
            executed.push(code);
            order.push("dispatch");
          },
        },
      }),
      env: { FREECODEZ_APPSHOT_HOTKEY: "cmd" },
      platform: "darwin",
      probeScreenCapture: () => screenGranted,
      requestScreenCaptureAccess: () => {
        order.push("request");
      },
      runSnapshot: async () => {
        order.push("snapshot");
        return {
          ok: true as const,
          app: { pid: 42, name: "Safari" },
          windowId: 7,
          capture: { path: "/tmp/appshot-7.png", bytes: 1024 },
          axTree: { elementCount: 120 },
        };
      },
      log: () => {},
    });
    controller.trigger();
    for (let i = 0; i < 20 && executed.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    controller.stop();
    return executed;
  };

  order.length = 0;
  await run(false);
  assert.deepEqual(order.slice(0, 2), ["request", "snapshot"], "未授权：自注册请求先于截屏");

  order.length = 0;
  const executed = await run(true);
  assert.equal(executed.length, 1, "已授权照常截屏派发");
  assert.deepEqual(order.slice(0, 1), ["snapshot"], "已授权：不发自注册请求");
  assert.ok(!order.includes("request"));
});
