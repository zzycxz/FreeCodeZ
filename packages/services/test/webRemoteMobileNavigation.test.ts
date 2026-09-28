// FreeCodeZ fork(2026-09-24 移动端远程控制):手机端伪路由状态机单测——
// history.state.zcodeMobilePage 初值/进 chat/返回/popstate 同步 + refreshKey 自增（附录C §7.2）。
// 2026-09-26 勘误:popstate 监听必须挂 window(history 不是 EventTarget);此前假 history
// 实现了 addEventListener 把真机必崩的挂载点掩盖成绿灯——本文件的 fakeHistory 刻意
// 不提供 addEventListener,再挂错宿主会当场抛错。
// 运行:node --import tsx --test packages/services/test/webRemoteMobileNavigation.test.ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  MOBILE_PAGE_STATE_KEY,
  buildMobilePageHistoryState,
  createMobileNavigationController,
  readMobilePageFromHistoryState,
  reduceNavigateToChat,
  reducePopstate,
  resolveInitialMobilePage,
  type HistoryLike,
  type MobileNavigationEvents,
} from "../../ui/src/mobile/mobileNavigation.js";

/** 假 history:与浏览器 History 同构——只有 state/pushState/back,没有 addEventListener。 */
function fakeHistory(initialState: unknown = null): HistoryLike & {
  states: unknown[];
  backCalls: number;
} {
  const history = {
    states: [initialState] as unknown[],
    backCalls: 0,
    get state(): unknown {
      return history.states[history.states.length - 1];
    },
    pushState(state: unknown): void {
      history.states.push(state);
    },
    back(): void {
      history.backCalls += 1;
      if (history.states.length > 1) history.states.pop();
    },
  };
  return history;
}

/** 假 window:popstate 宿主;back() 时按当前 history.state 派发事件(浏览器行为)。 */
function fakeWindow(history: HistoryLike & { states: unknown[] }): MobileNavigationEvents & {
  firePopstate(state: unknown): void;
  listenerCount(): number;
} {
  const listeners = new Set<(event: { state: unknown }) => void>();
  return {
    addEventListener(_type: "popstate", listener: (event: { state: unknown }) => void): void {
      listeners.add(listener);
    },
    removeEventListener(_type: "popstate", listener: (event: { state: unknown }) => void): void {
      listeners.delete(listener);
    },
    firePopstate(state: unknown): void {
      for (const listener of listeners) listener({ state });
    },
    listenerCount(): number {
      return listeners.size;
    },
  };
}

test("初值判定:intent==='chat' 或 history.state 残留 chat 即 chat(附录C §7.2 的 OR 语义)", () => {
  assert.equal(resolveInitialMobilePage({ navigationIntent: "chat", historyStatePage: null }), "chat");
  assert.equal(resolveInitialMobilePage({ navigationIntent: "home", historyStatePage: "chat" }), "chat");
  assert.equal(resolveInitialMobilePage({ navigationIntent: null, historyStatePage: "chat" }), "chat");
  assert.equal(resolveInitialMobilePage({ navigationIntent: null, historyStatePage: null }), "home");
  assert.equal(resolveInitialMobilePage({ navigationIntent: "home", historyStatePage: null }), "home");
  assert.equal(readMobilePageFromHistoryState({ [MOBILE_PAGE_STATE_KEY]: "chat" }), "chat");
  assert.equal(readMobilePageFromHistoryState(null), null);
  assert.equal(readMobilePageFromHistoryState({ [MOBILE_PAGE_STATE_KEY]: "bogus" }), null);
  assert.deepEqual(buildMobilePageHistoryState("chat"), { [MOBILE_PAGE_STATE_KEY]: "chat" });
});

test("状态机:进 chat 自增 refreshKey,popstate 同步视图并强制刷新", () => {
  assert.deepEqual(reduceNavigateToChat({ page: "home", refreshKey: 3 }), {
    page: "chat",
    refreshKey: 4,
  });
  assert.deepEqual(reducePopstate({ page: "chat", refreshKey: 4 }, "home"), {
    page: "home",
    refreshKey: 5,
  });
  // 同页 popstate(如 URL 参数变化)也自增 refreshKey,保证会话面重挂
  assert.deepEqual(reducePopstate({ page: "chat", refreshKey: 5 }, "chat"), {
    page: "chat",
    refreshKey: 6,
  });
  assert.deepEqual(reducePopstate({ page: "chat", refreshKey: 6 }, null), {
    page: "home",
    refreshKey: 7,
  });
});

test("控制器:popstate 挂 window(挂 history 即抛——真机 2026-09-26 崩溃回归锚)", () => {
  const history = fakeHistory();
  const win = fakeWindow(history);
  const controller = createMobileNavigationController({ history, events: win });
  assert.equal(win.listenerCount(), 1);
  controller.dispose();
  assert.equal(win.listenerCount(), 0);
  // 缺 events 直接抛(此前接口把 addEventListener 放在 history 上,真浏览器 history
  // 没有该方法,页面初始化即 t.addEventListener is not a function——所有浏览器必崩)。
  assert.throws(
    () =>
      // @ts-expect-error 故意省略 events:验证构造期显式失败而非静默错挂。
      createMobileNavigationController({ history }),
    /Cannot read|undefined|null/i,
  );
});

test("控制器:pushState 进 chat、window.popstate 返回、无 state 直接回 home", () => {
  const history = fakeHistory();
  const win = fakeWindow(history);
  const controller = createMobileNavigationController({ history, events: win });
  const seen: string[] = [];
  controller.subscribe((state) => seen.push(`${state.page}:${state.refreshKey}`));
  assert.equal(controller.state.page, "home");
  assert.equal(win.listenerCount(), 1, "popstate 监听必须挂在 window 宿主上");

  controller.navigateToChat();
  assert.equal(controller.state.page, "chat");
  assert.equal(controller.state.refreshKey, 1);
  assert.deepEqual(history.state, { [MOBILE_PAGE_STATE_KEY]: "chat" });

  // history.back() 后浏览器向 window 派发 popstate(带退栈后的 state)。
  history.back();
  win.firePopstate(history.state);
  assert.equal(controller.state.page, "home");
  assert.equal(controller.state.refreshKey, 2);

  // 无 state(直接落地页)返回不调用 history.back()
  const bareHistory = fakeHistory();
  const bareWin = fakeWindow(bareHistory);
  const bare = createMobileNavigationController({ history: bareHistory, events: bareWin });
  bare.navigateToChat();
  bareHistory.states[bareHistory.states.length - 1] = null; // 模拟外部清掉 state
  bare.navigateBack();
  assert.equal(bareHistory.backCalls, 0);
  assert.equal(bare.state.page, "home");

  assert.deepEqual(seen, ["chat:1", "home:2"]);
  controller.dispose();
  assert.equal(win.listenerCount(), 0, "dispose 必须摘除 window 上的 popstate 监听");
  bare.dispose();
});

test("控制器:刷新恢复——history.state 残留 chat 时初值即 chat", () => {
  const history = fakeHistory({ [MOBILE_PAGE_STATE_KEY]: "chat" });
  const win = fakeWindow(history);
  const controller = createMobileNavigationController({
    history,
    events: win,
    navigationIntent: null,
  });
  assert.equal(controller.state.page, "chat");
  controller.dispose();
});
