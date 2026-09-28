import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BootstrapResult,
  FailureReason,
  MobileDeviceInfo,
  RemoteTaskListItem,
  RemoteWorkspaceDescriptor,
} from "@zcode/shared/web-remote-control";
import {
  createMobileNavigationController,
  type MobileNavigationController,
  type MobileNavigationIntent,
  type MobilePage,
} from "./mobileNavigation.js";
import { buildMobileDeviceInfo } from "./mobileDeviceInfo.js";
import {
  armCollapseNavigationOnce,
  consumeCollapseNavigationOnce,
  readMobileTaskHomePreferences,
  writeMobileTaskHomePreferences,
  type MobileTaskHomePreferences,
  type StorageLike,
} from "./mobilePreferences.js";
import type {
  MobileBridgeConnection,
  MobileLinkFailure,
  MobileLinkState,
  MobileRemoteSession,
  MobileSidePaneContent,
} from "./mobileRemoteTypes.js";
import { taskWorkspaceKey, workspaceGroupKey } from "./mobileTaskGroups.js";

// MobileShell 的编排控制器（附录C §7.1 switcher 语义）：
//   listWorkspaces / onWorkspaceListUpdated / reconnectWorkspace /
//   startDraft(workspaceKey,{mobileNavigationIntent}) /
//   switchWorkspace(workspaceKey,{taskId,mobileNavigationIntent,markTaskReadExpectedUnreadAt}) /
//   updateMobileViewState(workspaceKey,taskId?) / markTaskRead(task)
// 打开任务（§7.4 f8t/d8t）：同 workspace→markTaskRead+updateMobileViewState+进 chat；
// 跨 workspace→switchWorkspace+切换遮罩；错误含「远程工作区尚未连接」→回 home。
// 导航收起（官方 WorkspaceShellLayout.pr + Zvn/Qvn，styles@5188754/@5178217）：
//   打开任务即收起导航面板（cn(!0)），跨 workspace 打开再武装一次性标志（Qvn）；
//   shell 挂载初始化消费一次（Zvn，读到 "1" 即清除并以收起态启动）。标志存 **sessionStorage**。

export const MOBILE_WORKSPACE_NOT_CONNECTED_MESSAGE = "远程工作区尚未连接";

export function isWorkspaceNotConnectedError(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes(
    MOBILE_WORKSPACE_NOT_CONNECTED_MESSAGE,
  );
}

/** 手机侧失败文案 key（failure.* + kicked 分流，spec §3）。 */
export function resolveFailureMessageId(failure: MobileLinkFailure): string {
  if (failure.message.includes("kicked")) return "webRemoteControl.failure.kicked";
  const byReason: Record<FailureReason, string> = {
    "session-not-found": "webRemoteControl.failure.sessionNotFound",
    "session-expired": "webRemoteControl.failure.sessionExpired",
    "session-conflict": "webRemoteControl.failure.sessionConflict",
    "workspace-closed": "webRemoteControl.failure.workspaceClosed",
    "desktop-disconnected": "webRemoteControl.failure.desktopDisconnected",
    "invalid-mobile-connection": "webRemoteControl.failure.invalidMobileConnection",
    "desktop-bootstrap-timeout": "webRemoteControl.failure.desktopBootstrapTimeout",
    "connection-recovery-timeout": "webRemoteControl.failure.connectionRecoveryTimeout",
    "relay-unavailable": "webRemoteControl.failure.relayUnavailable",
    "unsupported-action": "webRemoteControl.failure.unsupportedAction",
    "unexpected-error": "webRemoteControl.failure.unexpectedError",
  };
  return byReason[failure.reason];
}

export interface MobileActiveChat {
  workspace: RemoteWorkspaceDescriptor;
  workspaceKey: string;
  taskId: string | null;
  bridge: MobileBridgeConnection;
}

export interface MobileShellController {
  link: MobileLinkState;
  workspaces: readonly RemoteWorkspaceDescriptor[];
  tasks: readonly RemoteTaskListItem[];
  /** 官方 s5t 的 active 源（styles@3960579）：工作区分组默认展开集只含 active。 */
  activeWorkspaceKey: string | null;
  activeTask: RemoteTaskListItem | null;
  loading: boolean;
  errorText: string | null;
  preferences: MobileTaskHomePreferences;
  setPreferences: (preferences: MobileTaskHomePreferences) => void;
  page: MobilePage;
  chatRefreshKey: number;
  navigateToChat: () => void;
  navigateBack: () => void;
  active: MobileActiveChat | null;
  switching: boolean;
  failure: MobileLinkFailure | null;
  clearFailure: () => void;
  reconnectingWorkspaceKey: string | null;
  sidePaneOpen: boolean;
  setSidePaneOpen: (open: boolean) => void;
  sidePaneContent: MobileSidePaneContent | null;
  setSidePaneContent: (content: MobileSidePaneContent | null) => void;
  openTask: (task: RemoteTaskListItem) => void;
  startDraft: (workspaceKey: string) => void;
  reconnectWorkspace: (workspaceKey: string) => void;
  refresh: () => void;
  onSessionCreated: (sessionId: string) => void;
  onSessionDeleted: () => void;
  /** 导航面板（任务和工作区）折叠态；官方 sn（isCollapsed）。 */
  navigationCollapsed: boolean;
  toggleNavigationCollapsed: () => void;
}

/** 官方 f5 的存储面是 sessionStorage；隐私模式下 getter 可能抛异常，包一层静默降级。 */
function defaultCollapseOnceStorage(): StorageLike | undefined {
  try {
    return (globalThis as { sessionStorage?: StorageLike }).sessionStorage;
  } catch {
    return undefined;
  }
}

/** 桥/传输错误 → 失败语义：带 reason 的结构化错误直接透传，否则按兜底 reason 归档。 */
export function toLinkFailure(error: unknown, fallbackReason: FailureReason): MobileLinkFailure {
  if (typeof error === "object" && error !== null && "reason" in error && "message" in error) {
    const candidate = error as { reason: unknown; message: unknown };
    if (typeof candidate.reason === "string" && typeof candidate.message === "string") {
      return { reason: candidate.reason as FailureReason, message: candidate.message };
    }
  }
  return {
    reason: fallbackReason,
    message: String(error instanceof Error ? error.message : error),
  };
}

export function useMobileShellController(options: {
  session: MobileRemoteSession;
  navigationIntent?: MobileNavigationIntent | null;
  storage?: StorageLike;
  /** collapse-navigation-once 的存储面（官方 sessionStorage）；注入测试用。 */
  onceStorage?: StorageLike;
}): MobileShellController {
  const { session } = options;
  const storage = options.storage ?? (globalThis.localStorage as StorageLike | undefined);
  const onceStorage = options.onceStorage ?? defaultCollapseOnceStorage();
  const [link, setLink] = useState<MobileLinkState>(session.link);
  const [snapshot, setSnapshot] = useState<{
    workspaces: RemoteWorkspaceDescriptor[];
    tasks: RemoteTaskListItem[];
    activeWorkspaceKey: string | null;
  }>({ workspaces: [], tasks: [], activeWorkspaceKey: null });
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [preferences, setPreferencesState] = useState<MobileTaskHomePreferences>(() =>
    storage ? readMobileTaskHomePreferences(storage) : { organizeBy: "workspace", sortBy: "updated" },
  );
  const [active, setActive] = useState<MobileActiveChat | null>(null);
  const [switching, setSwitching] = useState(false);
  const [failure, setFailure] = useState<MobileLinkFailure | null>(null);
  const [reconnectingWorkspaceKey, setReconnectingWorkspaceKey] = useState<string | null>(null);
  const [sidePaneOpen, setSidePaneOpen] = useState(false);
  const [sidePaneContent, setSidePaneContent] = useState<MobileSidePaneContent | null>(null);
  // 官方 WorkspaceShellLayout `useState(()=>$t?Zvn():!1)`：shell 挂载时一次性消费收起标志，
  // 命中即清除（Zvn），本次会话以导航收起态启动。
  const [navigationCollapsed, setNavigationCollapsed] = useState<boolean>(
    () => (onceStorage ? consumeCollapseNavigationOnce(onceStorage) : false),
  );
  const [navState, setNavState] = useState(() => ({
    page: "home" as MobilePage,
    refreshKey: 0,
  }));
  const navigationRef = useRef<MobileNavigationController | null>(null);
  const deviceInfoRef = useRef<MobileDeviceInfo | null>(null);
  const lastViewStateKeyRef = useRef<string | null>(null);

  // 伪路由：history.state.zcodeMobilePage + popstate 同步（§7.2）。
  useEffect(() => {
    const controller = createMobileNavigationController({
      // DOM History 的泛型签名与 HistoryLike 的窄签名不完全同构，这里收口一次；
      // popstate 监听挂 window（history 不是 EventTarget，挂 history 会即崩）。
      history: globalThis.history as unknown as import("./mobileNavigation.js").HistoryLike,
      events: globalThis as unknown as import("./mobileNavigation.js").MobileNavigationEvents,
      navigationIntent: options.navigationIntent ?? null,
    });
    navigationRef.current = controller;
    setNavState(controller.state);
    const sub = controller.subscribe(setNavState);
    return () => {
      sub.dispose();
      controller.dispose();
      navigationRef.current = null;
    };
  }, [options.navigationIntent]);

  // 传输状态与工作区快照订阅。
  useEffect(() => {
    const linkSub = session.onLinkStateChange(setLink);
    const listSub = session.onWorkspaceListUpdated((result) => {
      setSnapshot({
        workspaces: result.workspaces,
        tasks: result.tasks ?? [],
        activeWorkspaceKey: result.activeWorkspaceKey ?? null,
      });
      setLoading(false);
    });
    let cancelled = false;
    setLoading(true);
    session
      .bootstrap()
      .then((result: BootstrapResult) => {
        if (cancelled) return;
        setSnapshot({
          workspaces: result.workspaces,
          tasks: result.tasks,
          activeWorkspaceKey:
            result.mobileViewState?.activeWorkspaceKey ??
            result.initialViewState?.activeWorkspaceKey ??
            null,
        });
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoading(false);
        setErrorText(String(error instanceof Error ? error.message : error));
      });
    return () => {
      cancelled = true;
      linkSub.dispose();
      listSub.dispose();
    };
  }, [session]);

  // 视图状态上报（mobile-view-state-update，桌面绿标数据源）：`workspaceKey:taskId` 去重。
  useEffect(() => {
    const viewStateKey =
      navState.page === "chat" && active
        ? `${active.workspaceKey}:${active.taskId ?? ""}`
        : "";
    if (lastViewStateKeyRef.current === viewStateKey) return;
    lastViewStateKeyRef.current = viewStateKey;
    if (!deviceInfoRef.current) deviceInfoRef.current = buildMobileDeviceInfo();
    const updatedAt = Date.now();
    if (navState.page === "chat" && active) {
      session.updateViewState(
        {
          activeWorkspaceKey: active.workspaceKey,
          ...(active.taskId ? { activeTaskId: active.taskId } : {}),
          updatedAt,
        },
        deviceInfoRef.current,
      );
    } else {
      session.updateViewState({ updatedAt }, deviceInfoRef.current);
    }
  }, [navState.page, active, session]);

  const setPreferences = useCallback(
    (next: MobileTaskHomePreferences) => {
      setPreferencesState(next);
      if (storage) writeMobileTaskHomePreferences(storage, next);
    },
    [storage],
  );

  const markTaskRead = useCallback((task: RemoteTaskListItem): void => {
    // 手机端 markTaskRead 只清本地未读投影（§7.1 switcher），不落服务端状态。
    setSnapshot((previous) => ({
      ...previous,
      tasks: previous.tasks.map((item) =>
        item.taskId === task.taskId ? { ...item, unreadAt: undefined } : item,
      ),
    }));
  }, []);

  const switchWorkspace = useCallback(
    async (workspaceKey: string, taskId: string | null): Promise<void> => {
      const workspace = snapshot.workspaces.find(
        (item) => workspaceGroupKey(item) === workspaceKey,
      );
      if (!workspace) {
        setFailure({ reason: "unexpected-error", message: workspaceKey });
        return;
      }
      setSwitching(true);
      try {
        session.closeWorkspaceBridge();
        const bridge = await session.openWorkspaceBridge({
          workspaceKey,
          ...(taskId ? { taskId } : {}),
        });
        setActive({ workspace, workspaceKey, taskId, bridge });
        setFailure(null);
        navigationRef.current?.navigateToChat();
      } catch (error) {
        if (isWorkspaceNotConnectedError(error)) {
          // 远程工作区未连接：回 home 等待重连（§7.4 打开任务错误分支）。
          setActive(null);
          if (navState.page === "chat") navigationRef.current?.navigateBack();
        }
        setFailure(toLinkFailure(error, "workspace-closed"));
      } finally {
        setSwitching(false);
      }
    },
    [navState.page, session, snapshot.workspaces],
  );

  const openTask = useCallback(
    (task: RemoteTaskListItem): void => {
      const workspaceKey = taskWorkspaceKey(task);
      // 官方 WorkspaceShellLayout.pr({crossWorkspace})（styles@5188754 邻域）：
      // `!$t||!bn||(cn(!0),e&&Qvn())`——手机视口 WRC shell 每次导航先收起导航面板（cn(!0)）；
      // 跨 workspace 导航（官方 d8t 的 `h=Ja(f)!==p`，p=active workspace key）再武装一次性
      // 标志（Qvn），供下次 shell 挂载消费（Zvn）。无已知 active workspace 时按跨 workspace 处理。
      setNavigationCollapsed(true);
      const activeWorkspaceKey = active?.workspaceKey ?? snapshot.activeWorkspaceKey ?? null;
      if (activeWorkspaceKey !== workspaceKey && onceStorage) {
        armCollapseNavigationOnce(onceStorage);
      }
      markTaskRead(task);
      if (active?.workspaceKey === workspaceKey && active.taskId === task.taskId) {
        navigationRef.current?.navigateToChat();
        return;
      }
      // 跨 workspace（或同 workspace 换任务）：switchWorkspace + 切换遮罩；
      // 换绑 taskId 需重开桥（Host 侧 initialTaskId 绑定会话）。
      void switchWorkspace(workspaceKey, task.taskId);
    },
    [active, markTaskRead, onceStorage, snapshot.activeWorkspaceKey, switchWorkspace],
  );

  const toggleNavigationCollapsed = useCallback((): void => {
    setNavigationCollapsed((previous) => !previous);
  }, []);

  const startDraft = useCallback(
    (workspaceKey: string): void => {
      void switchWorkspace(workspaceKey, null);
    },
    [switchWorkspace],
  );

  const reconnectWorkspace = useCallback(
    (workspaceKey: string): void => {
      setReconnectingWorkspaceKey(workspaceKey);
      void session
        .reconnectWorkspace(workspaceKey)
        .then((result) => {
          if (!result.success) {
            setFailure({ reason: "workspace-closed", message: result.error ?? workspaceKey });
          }
          return session.listWorkspaces();
        })
        .then((result) => {
          setSnapshot({
            workspaces: result.workspaces,
            tasks: result.tasks ?? [],
            activeWorkspaceKey: result.activeWorkspaceKey ?? null,
          });
        })
        .catch((error: unknown) => {
          setFailure(toLinkFailure(error, "workspace-closed"));
        })
        .finally(() => {
          setReconnectingWorkspaceKey(null);
        });
    },
    [session],
  );

  const refresh = useCallback((): void => {
    setLoading(true);
    session
      .listWorkspaces()
      .then((result) => {
        setSnapshot({
          workspaces: result.workspaces,
          tasks: result.tasks ?? [],
          activeWorkspaceKey: result.activeWorkspaceKey ?? null,
        });
        setErrorText(null);
      })
      .catch((error: unknown) => {
        setErrorText(String(error instanceof Error ? error.message : error));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [session]);

  const navigateBack = useCallback((): void => {
    navigationRef.current?.navigateBack();
    setSidePaneOpen(false);
    setSidePaneContent(null);
  }, []);

  const onSessionCreated = useCallback(
    (sessionId: string): void => {
      setActive((previous) => (previous ? { ...previous, taskId: sessionId } : previous));
      lastViewStateKeyRef.current = null;
    },
    [],
  );

  const onSessionDeleted = useCallback((): void => {
    setActive((previous) => (previous ? { ...previous, taskId: null } : previous));
    lastViewStateKeyRef.current = null;
  }, []);

  // 传输失败与桥失败统一进失败横幅（failure.* + kicked 分流）。
  useEffect(() => {
    if (link.failure) setFailure(link.failure);
  }, [link.failure]);

  const activeTask = useMemo(
    () => (active?.taskId ? snapshot.tasks.find((task) => task.taskId === active.taskId) ?? null : null),
    [active, snapshot.tasks],
  );

  return {
    link,
    workspaces: snapshot.workspaces,
    tasks: snapshot.tasks,
    activeWorkspaceKey: snapshot.activeWorkspaceKey,
    activeTask,
    loading,
    errorText,
    preferences,
    setPreferences,
    page: navState.page,
    chatRefreshKey: navState.refreshKey,
    navigateToChat: () => navigationRef.current?.navigateToChat(),
    navigateBack,
    active,
    switching,
    failure,
    clearFailure: () => setFailure(null),
    reconnectingWorkspaceKey,
    sidePaneOpen,
    setSidePaneOpen,
    sidePaneContent,
    setSidePaneContent,
    openTask,
    startDraft,
    reconnectWorkspace,
    refresh,
    onSessionCreated,
    onSessionDeleted,
    navigationCollapsed,
    toggleNavigationCollapsed,
  };
}
