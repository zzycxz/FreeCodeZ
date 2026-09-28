// 手机端任务首页偏好（附录C §7.7 localStorage）：
//   zcode-web-remote-control-mobile-task-home-preferences = {organizeBy, sortBy}
//   校验规则：两个字段必须同时合法，否则整体回退默认值（官方 i5t 语义）；读写 try/catch 静默。
//   zcode:web-remote-control:collapse-navigation-once = 导航面板一次性收起标志（官方 f5，
//   styles@5176968 声明、@5178217 邻域 Zvn/Qvn 读写）。
// 源码保真锚（ZCode 3.14.3 styles-DEELZGp2.js）：
//   - 官方把该键放在 **sessionStorage**（不是 localStorage；附录C 归为 localStorage 属勘误）；
//   - 作用对象是**导航面板**（aside#web-remote-control-navigation-panel，workspace-sidebar 整体
//     isCollapsed），不是工作区分组；webRemoteControl.expandNavigation/collapseNavigation
//     就是该 isCollapsed 开关的 aria-label（styles@5209882）；
//   - 写入时机：手机视口的 web-remote-control shell 导航时先收起导航面板，跨 workspace 导航
//     再武装标志（Qvn）；读取在 shell 挂载初始化，读到 "1" 即 removeItem 消费（Zvn，一次性）。
// 本模块为纯函数（storage 注入），packages/services/test 可直接单测。

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const MOBILE_TASK_HOME_PREFERENCES_KEY = "zcode-web-remote-control-mobile-task-home-preferences";
export const MOBILE_COLLAPSE_NAVIGATION_ONCE_KEY = "zcode:web-remote-control:collapse-navigation-once";

export type MobileOrganizeBy = "workspace" | "timeline";
export type MobileSortBy = "created" | "updated";

export interface MobileTaskHomePreferences {
  organizeBy: MobileOrganizeBy;
  sortBy: MobileSortBy;
}

export const DEFAULT_MOBILE_TASK_HOME_PREFERENCES: MobileTaskHomePreferences = {
  organizeBy: "workspace",
  sortBy: "updated",
};

const ORGANIZE_BY_VALUES: readonly MobileOrganizeBy[] = ["workspace", "timeline"];
const SORT_BY_VALUES: readonly MobileSortBy[] = ["created", "updated"];

function isOrganizeBy(value: unknown): value is MobileOrganizeBy {
  return ORGANIZE_BY_VALUES.includes(value as MobileOrganizeBy);
}

function isSortBy(value: unknown): value is MobileSortBy {
  return SORT_BY_VALUES.includes(value as MobileSortBy);
}

/**
 * 解析偏好 JSON：两字段同时合法才接受，否则整体回退默认值（不逐字段兜底）。
 * 非法 JSON / null / 类型不符都走同一回退路径。
 */
export function parseMobileTaskHomePreferences(raw: string | null | undefined): MobileTaskHomePreferences {
  if (!raw) return { ...DEFAULT_MOBILE_TASK_HOME_PREFERENCES };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_MOBILE_TASK_HOME_PREFERENCES };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ...DEFAULT_MOBILE_TASK_HOME_PREFERENCES };
  }
  const record = parsed as Record<string, unknown>;
  if (!isOrganizeBy(record["organizeBy"]) || !isSortBy(record["sortBy"])) {
    return { ...DEFAULT_MOBILE_TASK_HOME_PREFERENCES };
  }
  return { organizeBy: record["organizeBy"], sortBy: record["sortBy"] };
}

export function serializeMobileTaskHomePreferences(preferences: MobileTaskHomePreferences): string {
  return JSON.stringify({ organizeBy: preferences.organizeBy, sortBy: preferences.sortBy });
}

export function readMobileTaskHomePreferences(storage: StorageLike): MobileTaskHomePreferences {
  try {
    return parseMobileTaskHomePreferences(storage.getItem(MOBILE_TASK_HOME_PREFERENCES_KEY));
  } catch {
    // localStorage 在隐私模式/沙箱下可能抛异常，静默回退默认值。
    return { ...DEFAULT_MOBILE_TASK_HOME_PREFERENCES };
  }
}

export function writeMobileTaskHomePreferences(
  storage: StorageLike,
  preferences: MobileTaskHomePreferences,
): void {
  try {
    storage.setItem(MOBILE_TASK_HOME_PREFERENCES_KEY, serializeMobileTaskHomePreferences(preferences));
  } catch {
    // 写失败不影响本次会话内状态。
  }
}

/**
 * 一次性消费导航收起标志（官方 Zvn，styles@5178217 邻域，逐字节照抄语义）：
 * sessionStorage[key]==="1" → removeItem 并返回 true（**读取后即清除**）；
 * 未命中（含值非 "1"）或读取异常 → false。只在 web-remote-control shell 挂载初始化时读一次。
 */
export function consumeCollapseNavigationOnce(storage: StorageLike): boolean {
  try {
    if (storage.getItem(MOBILE_COLLAPSE_NAVIGATION_ONCE_KEY) === "1") {
      storage.removeItem(MOBILE_COLLAPSE_NAVIGATION_ONCE_KEY);
      return true;
    }
  } catch {
    // 官方 Zvn 的 catch 空转后返回 false。
  }
  return false;
}

/**
 * 武装导航收起标志（官方 Qvn，styles@5178217 邻域）：setItem(key,"1")，异常静默。
 * 写入时机 = 手机视口 WRC shell 的跨 workspace 导航（官方 pr 的 `e&&Qvn()`）。
 */
export function armCollapseNavigationOnce(storage: StorageLike): void {
  try {
    storage.setItem(MOBILE_COLLAPSE_NAVIGATION_ONCE_KEY, "1");
  } catch {
    // 官方 Qvn 的 catch 静默。
  }
}
