// 手机端伪路由（附录C §7.2）：视图 home|chat，路由状态存 history.state.zcodeMobilePage。
//   初值：intent==='chat' 或 history.state?.zcodeMobilePage==='chat' → chat；
//   进 chat = pushState({zcodeMobilePage:'chat'})；返回 = 有 state 则 history.back()，否则直接 setView；
//   popstate 同步视图并 refreshKey++（强制会话面按新地址重挂）。
// 本模块为纯状态机 + 可注入 history（packages/services/test 直接单测，无 DOM 依赖）。

export type MobilePage = "home" | "chat";
export type MobileNavigationIntent = "chat" | "home";

export const MOBILE_PAGE_STATE_KEY = "zcodeMobilePage";

export interface MobileNavigationState {
  page: MobilePage;
  /** popstate/返回后自增，用于强制刷新会话面（官方 refreshKey 语义）。 */
  refreshKey: number;
}

export interface HistoryLike {
  state: unknown;
  pushState(state: unknown, title?: string, url?: string | null): void;
  back(): void;
}

/**
 * popstate 事件宿主（浏览器 window）。规范上 popstate 派发到 window 而非 history——
 * history（History 接口）不是 EventTarget，没有 addEventListener；2026-09-26 真机扫码
 * 实锤把监听挂 history 会让手机页在所有浏览器初始化即崩（t.addEventListener is not a function）。
 */
export interface MobileNavigationEvents {
  addEventListener(type: "popstate", listener: (event: { state: unknown }) => void): void;
  removeEventListener(type: "popstate", listener: (event: { state: unknown }) => void): void;
}

export function readMobilePageFromHistoryState(state: unknown): MobilePage | null {
  if (typeof state !== "object" || state === null) return null;
  const page = (state as Record<string, unknown>)[MOBILE_PAGE_STATE_KEY];
  return page === "chat" || page === "home" ? page : null;
}

export function buildMobilePageHistoryState(page: MobilePage): Record<string, MobilePage> {
  return { [MOBILE_PAGE_STATE_KEY]: page };
}

/** 初值判定：intent 优先，其次 history.state 残留（刷新/回退后恢复视图）。 */
export function resolveInitialMobilePage(options: {
  navigationIntent?: MobileNavigationIntent | null;
  historyStatePage?: MobilePage | null;
}): MobilePage {
  if (options.navigationIntent === "chat") return "chat";
  return options.historyStatePage === "chat" ? "chat" : "home";
}

export function reduceNavigateToChat(state: MobileNavigationState): MobileNavigationState {
  return { page: "chat", refreshKey: state.refreshKey + 1 };
}

/** popstate 同步：history.state 的页面即事实，refreshKey 自增触发会话面重挂。 */
export function reducePopstate(
  state: MobileNavigationState,
  historyStatePage: MobilePage | null,
): MobileNavigationState {
  const page = historyStatePage ?? "home";
  if (page === state.page) return { page, refreshKey: state.refreshKey + 1 };
  return { page, refreshKey: state.refreshKey + 1 };
}

export interface MobileNavigationController {
  readonly state: MobileNavigationState;
  subscribe(listener: (state: MobileNavigationState) => void): { dispose(): void };
  /** 进 chat：pushState({zcodeMobilePage:'chat'}) 并本地视图切 chat。 */
  navigateToChat(): void;
  /** 返回首页：本会话内有 history.state 时走 history.back()（popstate 收口），否则直接切视图。 */
  navigateBack(): void;
  dispose(): void;
}

/**
 * 把状态机接到 window.history：视图变更只经 popstate/显式导航两条路径，
 * 保证浏览器手势返回、页面内返回按钮落到同一 reducer。
 */
export function createMobileNavigationController(options: {
  history: HistoryLike;
  events: MobileNavigationEvents;
  navigationIntent?: MobileNavigationIntent | null;
}): MobileNavigationController {
  const { history, events } = options;
  const listeners = new Set<(state: MobileNavigationState) => void>();
  let state: MobileNavigationState = {
    page: resolveInitialMobilePage({
      navigationIntent: options.navigationIntent ?? null,
      historyStatePage: readMobilePageFromHistoryState(history.state),
    }),
    refreshKey: 0,
  };

  function commit(next: MobileNavigationState): void {
    state = next;
    for (const listener of Array.from(listeners)) {
      try {
        listener(state);
      } catch {
        // 监听器异常不得影响路由状态机。
      }
    }
  }

  const onPopstate = (event: { state: unknown }): void => {
    commit(reducePopstate(state, readMobilePageFromHistoryState(event.state)));
  };
  events.addEventListener("popstate", onPopstate);

  return {
    get state(): MobileNavigationState {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    navigateToChat(): void {
      history.pushState(buildMobilePageHistoryState("chat"), "");
      commit(reduceNavigateToChat(state));
    },
    navigateBack(): void {
      if (readMobilePageFromHistoryState(history.state) !== null) {
        // 伪路由有 state 时交给 popstate 收口，保证历史栈与视图一致。
        history.back();
        return;
      }
      commit(reducePopstate(state, "home"));
    },
    dispose(): void {
      listeners.clear();
      events.removeEventListener("popstate", onPopstate);
    },
  };
}
