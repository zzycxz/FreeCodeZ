// Phase 2-1（升级实施手册 桌面控制 Phase 2 第一步）：光标 HUD 测试。
// ① 事件表纯函数（HUD wire 契约钉死：click=point→down→up 同序、drag 带 midpoint、
//    text 截断、非法坐标空表）；
// ② 帧解析（坏 JSON/版本不符/未知 kind 丢弃，合法帧保形）；
// ③ HUD 控制器（注入式 fake 窗口：惰性建窗/热点偏移/特效驱动/空闲隐藏/dispose）；
// ④ UDP 端到端（真 dgram：广播器发送 → 监听解析 → handleFrame 收到）。
import assert from "node:assert/strict";
import test from "node:test";
import { createSocket } from "node:dgram";
import {
  cursorEventsForClick,
  cursorEventsForDrag,
  cursorEventsForKey,
  cursorEventsForText,
  emitCursorEvents,
  CURSOR_EVENT_WIRE_VERSION,
} from "@zcode/computer-engine/host/cursor-events.js";
import {
  createCuaCursorHud,
  resolveHudScreenDeps,
  parseCursorEventFrame,
  cursorWindowPositionFor,
  CUA_CURSOR_HUD_UDP_PORT,
  CUA_CURSOR_HUD_IDLE_HIDE_MS,
  CUA_LENS_AUTO_OFF_MS,
  type CuaCursorEventFrame,
  type CuaCursorHudWindowLike,
} from "../src/main/cuaCursorHud.js";

test("事件表：click = point→down→up 同序同坐标（HUD 依此画移位+脉冲）", () => {
  const events = cursorEventsForClick({ x: 100.4, y: 200.7, button: "left" });
  assert.deepEqual(
    events.map((event) => event.kind),
    ["point", "down", "up"],
  );
  for (const event of events) {
    assert.equal(event.x, 100.4);
    assert.equal(event.y, 200.7);
    assert.equal(event.v, CURSOR_EVENT_WIRE_VERSION);
  }
  assert.equal(events[1]?.detail, "left");
});

test("事件表：drag 带中点；非法坐标空表；text 截断 40 字符", () => {
  const drag = cursorEventsForDrag({ fromX: 0, fromY: 0, toX: 100, toY: 50 });
  assert.deepEqual(
    drag.map((event) => event.kind),
    ["drag_start", "point", "drag_end"],
  );
  assert.equal(drag[1]?.x, 50);
  assert.deepEqual(cursorEventsForDrag({ fromX: Number.NaN, fromY: 0, toX: 1, toY: 1 }), []);
  const long = cursorEventsForText({ text: "x".repeat(80) });
  assert.equal(long[0]?.detail?.endsWith("…"), true);
  assert.equal(long[0]?.detail?.length, 41);
  assert.deepEqual(cursorEventsForText({ text: "" }), []);
});

test("事件表：key 事件带 detail；emitCursorEvents 异常吞掉不中断", () => {
  const events = cursorEventsForKey({ key: "cmd+shift+t" });
  assert.equal(events[0]?.kind, "key");
  assert.equal(events[0]?.detail, "cmd+shift+t");
  let calls = 0;
  emitCursorEvents(
    () => {
      calls += 1;
      if (calls === 1) throw new Error("HUD side failure must not break actions");
    },
    events.concat(events),
  );
  assert.equal(calls, 2, "第二个事件仍发射（发射器异常被吞）");
});

test("帧解析：合法保形/坏 JSON/版本不符/未知 kind 全防", () => {
  const frame = parseCursorEventFrame('{"v":1,"kind":"point","x":10,"y":20}');
  assert.deepEqual(frame, { v: 1, kind: "point", x: 10, y: 20 });
  assert.equal(parseCursorEventFrame("not json"), undefined);
  assert.equal(parseCursorEventFrame('{"v":2,"kind":"point"}'), undefined);
  assert.equal(parseCursorEventFrame('{"v":1,"kind":"explode"}'), undefined);
  assert.equal(parseCursorEventFrame('{"v":1,"kind":"point","x":"abc"}')?.x, undefined);
});

test("窗口映射：热点偏移 4,4 取整", () => {
  assert.deepEqual(cursorWindowPositionFor({ v: 1, kind: "point", x: 100.4, y: 50.7 }), {
    x: 96,
    y: 47,
  });
  assert.equal(cursorWindowPositionFor({ v: 1, kind: "key" }), undefined);
});

class FakeHudWindow {
  visible = false;
  destroyed = false;
  position = { x: -1000, y: -1000 };
  executed: string[] = [];
  loadedUrls: string[] = [];
  onClosed: () => void = () => undefined;
  setPosition(x: number, y: number) {
    this.position = { x, y };
  }
  setBounds() {
    undefined;
  }
  showInactive() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  close() {
    this.destroyed = true;
  }
  isVisible() {
    return this.visible;
  }
  isDestroyed() {
    return this.destroyed;
  }
  once(_event: "closed", listener: () => void) {
    this.onClosed = listener;
  }
  setIgnoreMouseEvents() {
    undefined;
  }
  setAlwaysOnTop() {
    undefined;
  }
  loadURL(url: string) {
    this.loadedUrls.push(url);
    return Promise.resolve();
  }
  webContents = {
    send() {
      undefined;
    },
    once() {
      undefined;
    },
    executeJavaScript: async (code: string) => {
      this.executed.push(code);
      return undefined;
    },
  };
}

/** 每次构造都登记到 created 的 BrowserWindow 桩类。 */
function makeFakeBrowserWindowClass(created: FakeHudWindow[]) {
  return class {
    constructor() {
      const win = new FakeHudWindow();
      created.push(win);
      return win;
    }
  };
}

test("HUD 控制器：惰性建窗/移位/特效/空闲隐藏/dispose（注入式）", () => {  const created: FakeHudWindow[] = [];
  const hud = createCuaCursorHud({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    BrowserWindow: makeFakeBrowserWindowClass(created) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1055 } }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    createUdpListener: () => ({ close() { undefined; } }),
  });
  hud.handleFrame({ v: 1, kind: "point", x: 300, y: 400 });
  assert.equal(created.length, 2, "首事件创建光标窗+横幅窗");
  const cursorWindow = created[0];
  assert.ok(cursorWindow, "光标窗先建");
  assert.deepEqual(cursorWindow.position, { x: 296, y: 396 }, "热点偏移后的窗位");
  assert.equal(cursorWindow.visible, true);
  hud.handleFrame({ v: 1, kind: "down", x: 300, y: 400 });
  assert.ok(cursorWindow.executed.some((code) => code.includes("__cuaDown()")), "down 帧驱动按下特效");
  hud.handleFrame({ v: 1, kind: "up", x: 300, y: 400 });
  assert.ok(cursorWindow.executed.some((code) => code.includes("__cuaUp()")), "up 帧驱动抬起+脉冲");
  hud.dispose();
  assert.ok(cursorWindow.destroyed, "dispose 关窗");
  // dispose 后帧不再驱动。
  hud.handleFrame({ v: 1, kind: "point", x: 1, y: 1 });
  assert.equal(created.length, 2);
});

test("Phase 2 loading 透镜：45 步进样式锚定/text 帧点亮/移动帧熄灭/静默自熄", async () => {
  const created: FakeHudWindow[] = [];
  const hud = createCuaCursorHud({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    BrowserWindow: makeFakeBrowserWindowClass(created) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1055 } }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    createUdpListener: () => ({ close() { undefined; } }),
  });
  hud.handleFrame({ v: 1, kind: "point", x: 100, y: 100 });
  const cursorWindow = created[0];
  assert.ok(cursorWindow, "光标窗已建");
  // 45 帧步进语义 + 页面透镜开关函数在窗页 HTML 内（data:URL 字面量断言——
  // encodeURIComponent 不编码括号/字母数字，steps(45)/__cuaLoading 保持字面）。
  assert.ok(
    cursorWindow.loadedUrls.some((url) => url.includes("steps(45)")),
    "透镜动画为 45 离散步进（对齐 Codex 光标规格帧数）",
  );
  assert.ok(cursorWindow.loadedUrls.some((url) => url.includes("__cuaLoading")), "页面有透镜开关全局函数");
  // 熄灭态首发帧不产生多余调用（lensOn 幂等）。
  assert.ok(!cursorWindow.executed.some((code) => code.startsWith("__cuaLoading")));
  // text 帧（打字中）→ 点亮。
  hud.handleFrame({ v: 1, kind: "text", detail: "hello" });
  assert.ok(cursorWindow.executed.includes("__cuaLoading(true)"), "text 帧点亮透镜");
  // 点击帧 → 熄灭。
  hud.handleFrame({ v: 1, kind: "down", x: 100, y: 100 });
  assert.ok(cursorWindow.executed.includes("__cuaLoading(false)"), "点击帧熄灭透镜");
  // 自熄：text 后无后续帧，超过 CUA_LENS_AUTO_OFF_MS 自动熄灭。
  hud.handleFrame({ v: 1, kind: "text", detail: "again" });
  const offCalls = () => cursorWindow.executed.filter((code) => code === "__cuaLoading(false)").length;
  const before = offCalls();
  await new Promise((resolve) => setTimeout(resolve, CUA_LENS_AUTO_OFF_MS + 150));
  assert.equal(offCalls(), before + 1, "静默超时后透镜自熄");
  hud.dispose();
});

test("UDP 端到端：真 dgram 广播→监听→帧解析", async () => {
  const received: CuaCursorEventFrame[] = [];
  const created: FakeHudWindow[] = [];
  const hud = createCuaCursorHud({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    BrowserWindow: makeFakeBrowserWindowClass(created) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1055 } }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    createUdpListener: (port, onFrame) => {
      // 真 dgram 绑定（与生产 listener 同实现路径）
      const socket = createSocket("udp4");
      socket.on("message", (message: Buffer) => {
        const frame = parseCursorEventFrame(message.toString("utf8"));
        if (frame) {
          received.push(frame);
          onFrame(frame);
        }
      });
      socket.bind(port, "127.0.0.1");
      return {
        close() {
          try {
            socket.close();
          } catch {
            undefined;
          }
        },
      };
    },
  });
  // 广播端（模拟 node-repl-host 的 broadcaster）
  const sender = createSocket("udp4");
  sender.send(
    Buffer.from(JSON.stringify({ v: 1, kind: "point", x: 42, y: 99 })),
    CUA_CURSOR_HUD_UDP_PORT,
    "127.0.0.1",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  sender.close();
  hud.dispose();
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { v: 1, kind: "point", x: 42, y: 99 });
  assert.equal(created.length, 2, "端到端帧同样驱动 HUD 建窗");
});

test("Esc 取消：注册/注销生命周期（注入式 globalShortcut）", () => {
  const registered: Array<{ accelerator: string; callback: () => void }> = [];
  const unregistered: string[] = [];
  let cancelled = 0;
  const created: FakeHudWindow[] = [];
  const hud = createCuaCursorHud({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    BrowserWindow: makeFakeBrowserWindowClass(created) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1055 } }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    createUdpListener: () => ({ close() { undefined; } }),
    globalShortcut: {
      register(accelerator, callback) {
        registered.push({ accelerator, callback });
      },
      unregister(accelerator) {
        unregistered.push(accelerator);
      },
    },
    onUserCancel: () => {
      cancelled += 1;
    },
  });
  hud.handleFrame({ v: 1, kind: "point", x: 100, y: 200 });
  assert.equal(registered.length, 1, "首个事件注册 Esc");
  assert.equal(registered[0]?.accelerator, "Escape");
  registered[0]?.callback();
  assert.equal(cancelled, 1, "Esc 触发 onUserCancel");
  hud.dispose();
  assert.ok(unregistered.includes("Escape"), "dispose 注销 Esc");
});

test("用户干预：paused 期间帧不驱动特效", () => {
  const created: FakeHudWindow[] = [];
  // 恒活跃的 mouse 轮询（用户一直在动鼠标）
  const hud = createCuaCursorHud({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    BrowserWindow: makeFakeBrowserWindowClass(created) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1055 } }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    createUdpListener: () => ({ close() { undefined; } }),
    loadBindings: () => null,
  });
  hud.handleFrame({ v: 1, kind: "point", x: 100, y: 200 });
  // loadBindings 返回 null → readUserMouseActivity 恒不活跃 → 不 paused
  const cursor = created[0];
  assert.ok(cursor);
  hud.dispose();
});

// 2026-10-07 装机实测回归两连（同日）：①Electron 41 已移除 screen.screenToDipPoint，装配层
// 曾用无条件箭头包装把可选降级吃掉——包装内部调 undefined，首个光标帧即炸 main；
// ②typeof 探测又在装配期访问 screen 属性——electron screen 是懒初始化代理，app ready 前
// 访问任何属性即抛 "The 'screen' module can't be used before the app 'ready' event"
//（main 模块顶层装配 → 启动即炸）。探测必须延迟到首次调用。
test("装配：API 缺席时调用返回 undefined（控制器 `??` fallback 生效）", () => {
  const deps = resolveHudScreenDeps({
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1055 } }),
  });
  assert.equal(deps.screenToDipPoint?.({ x: 10, y: 20 }), undefined, "缺席时返回 undefined 而非硬调");
  assert.ok(typeof deps.getPrimaryDisplay() === "object");
});

test("装配：API 在场时透传换算（旧 Electron 兼容）", () => {
  const deps = resolveHudScreenDeps({
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1055 } }),
    screenToDipPoint: (point: { x: number; y: number }) => ({ x: point.x * 2, y: point.y * 2 }),
  });
  assert.deepEqual(deps.screenToDipPoint?.({ x: 10, y: 20 }), { x: 20, y: 40 });
});

test("回归：装配期不得访问 screen 任何属性（electron ready 前的懒初始化代理一碰即抛）", () => {
  // 模拟 app ready 前的 electron screen：属性访问即抛（typeof 探测也算访问）。
  const preReadyScreen = new Proxy(
    { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1055 } }) },
    {
      get(target, prop, receiver) {
        if (prop === "getPrimaryDisplay") return Reflect.get(target, prop, receiver);
        throw new Error("The 'screen' module can't be used before the app 'ready' event");
      },
    },
  ) as unknown as Parameters<typeof resolveHudScreenDeps>[0];
  // 装配在 main 模块顶层执行——这里不抛即通过；属性访问推迟到调用（且异常被 handleFrame 兜底）。
  const deps = resolveHudScreenDeps(preReadyScreen);
  assert.equal(typeof deps.screenToDipPoint, "function");
});

test("回归：UDP 帧处理抛异常不得冒泡（丢帧不炸 main、不阻断退出）", () => {
  const created: FakeHudWindow[] = [];
  const explodingWindowClass = class {
    constructor() {
      const win = new FakeHudWindow();
      // 定位即炸：模拟换算/窗操作异常面。
      win.setPosition = () => {
        throw new Error("synthetic frame-handler failure");
      };
      created.push(win);
      return win;
    }
  };
  const hud = createCuaCursorHud({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    BrowserWindow: explodingWindowClass as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1055 } }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    createUdpListener: () => ({ close() { undefined; } }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (hud.handleFrame as any)({ v: 1, kind: "point", x: 300, y: 400 });
  hud.dispose();
});

// ── 回归（2026-10-08 装机实测：任务停止后 HUD 横幅常驻不消）────────────────
// 根因两处：① hideAll 半执行（单窗 hide 抛异常中断后续行 / isVisible 误报 false
// 跳过隐藏）留下"光标已隐、横幅挂屏"残局；② scheduleIdleHide 武装在帧尾，
// 帧处理中途抛异常被丢帧兜底吞掉后"窗口已显、计时器没武装"，6 秒自隐永不来。
// 三例分别钉死：每窗独立隐藏、hide 幂等无守卫、计时器先于一切抛异常面武装。

test("回归：空闲隐藏单窗 hide 抛异常不得留半隐藏残局（横幅常驻 2026-10-08）", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const created: FakeHudWindow[] = [];
  const hud = createCuaCursorHud({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    BrowserWindow: makeFakeBrowserWindowClass(created) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1055 } }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    createUdpListener: () => ({ close() { undefined; } }),
  });
  hud.handleFrame({ v: 1, kind: "point", x: 300, y: 400 });
  const cursorWindow = created[0];
  const bannerWindow = created[1];
  assert.ok(cursorWindow && bannerWindow);
  assert.equal(cursorWindow.visible, true);
  assert.equal(bannerWindow.visible, true);
  cursorWindow.hide = () => {
    throw new Error("synthetic hide failure");
  };
  t.mock.timers.tick(CUA_CURSOR_HUD_IDLE_HIDE_MS);
  assert.equal(bannerWindow.visible, false, "第一窗 hide 抛异常也必须隐藏第二窗（每窗独立）");
  hud.dispose();
});

test("回归：isVisible 误报 false 不得跳过 hide（2026-10-08 横幅常驻）", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const created: FakeHudWindow[] = [];
  const hud = createCuaCursorHud({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    BrowserWindow: makeFakeBrowserWindowClass(created) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1055 } }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    createUdpListener: () => ({ close() { undefined; } }),
  });
  hud.handleFrame({ v: 1, kind: "point", x: 300, y: 400 });
  const bannerWindow = created[1];
  assert.ok(bannerWindow);
  assert.equal(bannerWindow.visible, true);
  let hideCalls = 0;
  bannerWindow.isVisible = () => false; // 误报：窗实际在屏（panel 窗可见性误报实测形态）
  bannerWindow.hide = () => {
    hideCalls += 1;
    bannerWindow.visible = false;
  };
  t.mock.timers.tick(CUA_CURSOR_HUD_IDLE_HIDE_MS);
  assert.equal(hideCalls, 1, "hide 幂等、无条件执行（不得被 isVisible 守卫跳过）");
  assert.equal(bannerWindow.visible, false);
  hud.dispose();
});

test("回归：显示链中途抛异常仍须武装空闲隐藏（计时器先于抛异常面）", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const created: FakeHudWindow[] = [];
  const boomBannerClass = class {
    constructor() {
      const win = new FakeHudWindow();
      // 第二个窗（横幅）show 即炸：模拟显示阶段窗销毁竞态，整帧被丢帧兜底吞掉。
      if (created.length === 1) {
        win.showInactive = () => {
          throw new Error("synthetic show failure");
        };
      }
      created.push(win);
      return win;
    }
  };
  const hud = createCuaCursorHud({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    BrowserWindow: boomBannerClass as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1055 } }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    createUdpListener: () => ({ close() { undefined; } }),
  });
  hud.handleFrame({ v: 1, kind: "point", x: 300, y: 400 });
  const cursorWindow = created[0];
  assert.ok(cursorWindow);
  assert.equal(cursorWindow.visible, true, "光标窗已显（横幅 show 抛异常帧被吞）");
  t.mock.timers.tick(CUA_CURSOR_HUD_IDLE_HIDE_MS);
  assert.equal(cursorWindow.visible, false, "帧已到达→6 秒必隐（与显示/特效是否抛异常无关）");
  hud.dispose();
});
