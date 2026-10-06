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
} from "@zcode/zcode-cua/macos";
import {
  createCuaCursorHud,
  parseCursorEventFrame,
  cursorWindowPositionFor,
  CUA_CURSOR_HUD_UDP_PORT,
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
  loadURL() {
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

test("HUD 控制器：惰性建窗/移位/特效/空闲隐藏/dispose（注入式）", () => {
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
