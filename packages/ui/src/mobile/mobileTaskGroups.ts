import type {
  RemoteTaskListItem,
  RemoteWorkspaceDescriptor,
} from "@zcode/shared/web-remote-control";

// 手机端任务首页的分组/排序/时间线纯函数（附录C §7.4）：
//  - 组织方式 organizeBy：workspace 分组卡 | taskTimeline.* 时间线分组；
//  - 排序 = 官方 Wu（@145385）∘ fue（@145078）∘ H8t（@3956152）：运行中置顶 + 降序链 + taskId localeCompare 降序；
//  - 时间线分桶：today/yesterday/daysAgo/thisWeek/lastWeek/thisMonth/lastMonth/older。
// 本文件无 React/DOM 依赖，packages/services/test 可直接单测。
//
// 源码保真锚（ZCode 3.14.3 styles-DEELZGp2.js，手机 home p5t 邻域）：
//  - 分桶判定链 = 官方 L8t（@3955238）+ w2/F8t/I8t 日界工具，逐字节照抄（kind/daysAgo→key/days 字段名对应）。
//  - displayStatus 归并 = 官方 J8t（@3956787）∘ q8t（@3956592）∘ V8t（@3956093），见文件末尾。

export type MobileTimelineBucketKey =
  | "today"
  | "yesterday"
  | "daysAgo"
  | "thisWeek"
  | "lastWeek"
  | "thisMonth"
  | "lastMonth"
  | "older";

export interface MobileTimelineBucket {
  key: MobileTimelineBucketKey;
  /** 仅 daysAgo 桶携带天数（taskTimeline.daysAgo{days}；官方 label 字段名 daysAgo）。 */
  days?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 官方 w2：本地自然日 0 点（new Date(y,m,d) 本地时区构造，非 UTC）。 */
function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 官方 F8t：本地自然月 1 日 0 点。 */
function startOfLocalMonth(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

/**
 * 官方 I8t：本地周起点。周起始按 locale 精确匹配——`t===\`en-US\`` 周日，其余周一
 * （不是宽松正则；en-us/en_US/en 都走周一）。日回退用 Date.setDate（DST 安全），不做毫秒减法。
 */
function startOfLocalWeek(timestamp: number, locale: string): number {
  const date = new Date(startOfLocalDay(timestamp));
  const weekStartsOn = locale === "en-US" ? 0 : 1;
  const offset = (date.getDay() - weekStartsOn + 7) % 7;
  date.setDate(date.getDate() - offset);
  return date.getTime();
}

/**
 * 时间线分桶（官方 L8t 逐字节照抄）：
 *  - 日差 a = Math.floor((今日0点 - 任务日0点) / DAY_MS)（本地午夜对齐后再相除）；
 *  - a<=0 → today（含未来时间戳）；a===1 → yesterday；a<=3 → daysAgo（上界 3 天，即仅 2/3 天前）；
 *  - 其后按日0点比较（i>=o，不是原始毫秒）：>= 本周起点 → thisWeek；>= 上周起点 → lastWeek；
 *  - >= 本月1日 → thisMonth；>= 上月1日 → lastMonth；其余 older。
 */
export function timelineBucketFor(timestamp: number, now: number, locale: string): MobileTimelineBucket {
  const nowDay = startOfLocalDay(now);
  const taskDay = startOfLocalDay(timestamp);
  const dayDiff = Math.floor((nowDay - taskDay) / DAY_MS);
  if (dayDiff <= 0) return { key: "today" };
  if (dayDiff === 1) return { key: "yesterday" };
  if (dayDiff <= 3) return { key: "daysAgo", days: dayDiff };
  const weekStart = startOfLocalWeek(now, locale);
  if (taskDay >= weekStart) return { key: "thisWeek" };
  if (taskDay >= weekStart - 7 * DAY_MS) return { key: "lastWeek" };
  if (taskDay >= startOfLocalMonth(now)) return { key: "thisMonth" };
  const nowDate = new Date(now);
  return taskDay >= new Date(nowDate.getFullYear(), nowDate.getMonth() - 1, 1).getTime()
    ? { key: "lastMonth" }
    : { key: "older" };
}

export interface MobileTaskStatusPill {
  /** 四态：idle|running|completed|error（webRemoteControl.taskStatus.*）。 */
  status: "idle" | "running" | "completed" | "error";
  toneClassName: string;
  icon: "loader" | "circle-check" | "circle-alert" | "circle";
}

/** 状态 pill 映射（附录C §7.4 k2）：running→border-brand/loader、completed→border-success/circle-check、error→border-destructive/circle-alert、idle→border-border。 */
export function taskStatusPill(
  status: "idle" | "running" | "completed" | "error" | undefined,
): MobileTaskStatusPill {
  switch (status) {
    case "running":
      return { status: "running", toneClassName: "border-brand text-brand", icon: "loader" };
    case "completed":
      return { status: "completed", toneClassName: "border-success text-success", icon: "circle-check" };
    case "error":
      return { status: "error", toneClassName: "border-destructive text-destructive", icon: "circle-alert" };
    default:
      return { status: "idle", toneClassName: "border-border text-foreground-subtle", icon: "circle" };
  }
}

export type MobileTaskDisplayStatus = "idle" | "running" | "completed" | "error";

/**
 * 官方 q8t（styles@3956592）逐字节照抄：session/workflow phase → displayStatus。
 * prewarming|running→running；completedSuccess|completedInterrupted→completed；error→error；
 * draft→undefined（落空，J8t 续走 runtime 链）；枚举外原样透传（尾部 `return e`）。
 */
export function mapTaskPhaseToDisplayStatus(phase: string | undefined | null): string | undefined {
  switch (phase) {
    case "prewarming":
    case "running":
      return "running";
    case "completedSuccess":
    case "completedInterrupted":
      return "completed";
    case "error":
      return "error";
    case "draft":
      return undefined;
  }
  return phase ?? undefined;
}

/**
 * 官方 V8t（styles@3956093）逐字节照抄：runtime 状态是否算在跑——
 * 仅 creating|streaming（注意与 L9 的 creating|restoring|streaming 不同，restored 不算）。
 */
export function isRuntimeRunningStatus(runtimeStatus: string | undefined | null): boolean {
  return runtimeStatus === "creating" || runtimeStatus === "streaming";
}

/** 官方 J8t 的输入面（styles@3956787）：task（活性 + 持久态）与 runtimeStatus。 */
export interface MergeTaskDisplayStatusInput {
  task: {
    /** 官方 Vu(task)=task.__zcodeSessionActivity（会话活性挂载）；J8t 只读其 phase。 */
    readonly __zcodeSessionActivity?: { readonly phase?: string | null } | null | undefined;
    /** 官方 e.status：任务持久态（zcodeTaskPersistStatus：running|completed|error）。 */
    readonly status?: string | null | undefined;
  };
  /** 官方 runtimeStatus：taskRuntimeByTaskId[taskId]?.status。 */
  readonly runtimeStatus?: string | null | undefined;
}

/**
 * displayStatus 归并（官方 J8t 逐字节照抄，styles@3956787）：
 *  1) 有活性 → q8t(phase)，结果为真即采用（draft 落空续走）；
 *  2) runtimeStatus creating|streaming → running；
 *  3) runtimeStatus===failed 或 task.status===error → error；
 *  4) runtimeStatus===completed 或 task.status===completed → completed；
 *  5) 其余 → idle（注意 task.status===running 也落 idle）。
 * 枚举外 phase 由 q8t 原样透传（as 收窄仅覆盖该越界分支）。
 */
export function mergeTaskDisplayStatus({
  task,
  runtimeStatus,
}: MergeTaskDisplayStatusInput): MobileTaskDisplayStatus {
  const activity = task.__zcodeSessionActivity ?? null;
  if (activity) {
    const mapped = mapTaskPhaseToDisplayStatus(activity.phase);
    if (mapped) return mapped as MobileTaskDisplayStatus;
  }
  return isRuntimeRunningStatus(runtimeStatus)
    ? "running"
    : runtimeStatus === "failed" || task.status === "error"
      ? "error"
      : runtimeStatus === "completed" || task.status === "completed"
        ? "completed"
        : "idle";
}

export function isTaskUnread(task: RemoteTaskListItem): boolean {
  return typeof task.unreadAt === "number" && task.unreadAt > 0;
}

/** 排序：created|updated 降序，tie-break createdAt 降序 → taskId 升序（§1.7 同口径）。 */
/** 官方 H8t（styles@3956152）：运行中/有后台工作的任务置顶。 */
function hasMobileTaskSortPriority(task: RemoteTaskListItem): boolean {
  return task.displayStatus === "running" || task.hasBackgroundWork === true;
}

/**
 * 官方 fue（styles@145078）基础比较链：
 * created 模式 = createdAt 降序 → updatedAt 降序 → taskId localeCompare 降序；
 * updated 模式 = updatedAt 降序 → createdAt 降序 → taskId localeCompare 降序。
 * taskId 比较为 `t.taskId.localeCompare(e.taskId)`（B 对 A），整体即降序。
 */
function compareMobileTasksBase(
  a: RemoteTaskListItem,
  b: RemoteTaskListItem,
  sortBy: "created" | "updated",
): number {
  if (sortBy === "created") {
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return b.taskId.localeCompare(a.taskId);
  }
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return b.taskId.localeCompare(a.taskId);
}

/**
 * 官方 Wu（styles@145385）：H8t 置顶优先；双置顶走 createdAt 降序 → taskId localeCompare 降序
 *（注意不查 updatedAt）；双非置顶走 fue 全链；置顶态不同则置顶者在前。
 */
export function compareTasksForSort(
  a: RemoteTaskListItem,
  b: RemoteTaskListItem,
  sortBy: "created" | "updated",
): number {
  const aTop = hasMobileTaskSortPriority(a);
  const bTop = hasMobileTaskSortPriority(b);
  if (aTop !== bTop) return aTop ? -1 : 1;
  if (aTop) {
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    return b.taskId.localeCompare(a.taskId);
  }
  return compareMobileTasksBase(a, b, sortBy);
}

/** 官方 E2（styles@3957981）：`[...e].sort(Y8t(t))`，分组与置顶区共用的唯一排序入口。 */
export function sortMobileTasks(
  tasks: readonly RemoteTaskListItem[],
  sortBy: "created" | "updated",
): RemoteTaskListItem[] {
  return [...tasks].sort((a, b) => compareTasksForSort(a, b, sortBy));
}

export function taskWorkspaceKey(task: RemoteTaskListItem): string {
  return task.workspaceIdentity?.trim() || task.workspacePath;
}

export function workspaceGroupKey(workspace: RemoteWorkspaceDescriptor): string {
  return workspace.workspaceIdentity?.trim() || workspace.workspacePath;
}

export interface MobileWorkspaceTaskGroup {
  workspace: RemoteWorkspaceDescriptor;
  workspaceKey: string;
  tasks: RemoteTaskListItem[];
  hasUnread: boolean;
}

/** workspace 分组：保持 bootstrap/workspace-list 给出的工作区顺序，组内按 sortBy 排序。 */
export function groupTasksByWorkspace(
  workspaces: readonly RemoteWorkspaceDescriptor[],
  tasks: readonly RemoteTaskListItem[],
  sortBy: "created" | "updated",
): MobileWorkspaceTaskGroup[] {
  const byWorkspace = new Map<string, RemoteTaskListItem[]>();
  for (const task of tasks) {
    const key = taskWorkspaceKey(task);
    const bucket = byWorkspace.get(key);
    if (bucket) {
      bucket.push(task);
    } else {
      byWorkspace.set(key, [task]);
    }
  }
  return workspaces.map((workspace) => {
    const workspaceKey = workspaceGroupKey(workspace);
    // 官方 Q8t（styles@3957981）：组内 `tasks: E2(e.tasks, n)` 排序。
    const groupTasks = sortMobileTasks(byWorkspace.get(workspaceKey) ?? [], sortBy);
    return {
      workspace,
      workspaceKey,
      tasks: groupTasks,
      hasUnread: groupTasks.some(isTaskUnread),
    };
  });
}

export interface MobileTimelineTaskGroup {
  bucket: MobileTimelineBucket;
  tasks: RemoteTaskListItem[];
}

/**
 * timeline 分组（官方 B8t 逐字节照抄，styles@3955865）：**首见序分桶、组内不再排序**——
 * 输入须先经 sortMobileTasks（=官方 E2），分桶按遇序 append，组序=首见序。
 * 选项形如官方 B8t 第二参 `{sortBy, now, locale}`（分桶时间戳按 sortBy 取 created/updated）。
 */
export function groupTasksByTimeline(
  tasks: readonly RemoteTaskListItem[],
  options: { sortBy: "created" | "updated"; now: number; locale: string },
): MobileTimelineTaskGroup[] {
  const groups = new Map<string, { bucket: MobileTimelineBucket; tasks: RemoteTaskListItem[] }>();
  for (const task of tasks) {
    const timestamp = options.sortBy === "created" ? task.createdAt : task.updatedAt;
    const bucket = timelineBucketFor(timestamp, options.now, options.locale);
    const key = `${bucket.key}:${bucket.days ?? ""}`;
    const existing = groups.get(key);
    if (existing) {
      existing.tasks.push(task);
    } else {
      groups.set(key, { bucket, tasks: [task] });
    }
  }
  return Array.from(groups.values());
}

/** 置顶区（只读展示，§7.5 手机端不提供置顶/归档操作）；官方 `l=E2(c.filter(pinned),r)`。 */
export function collectPinnedTasks(
  tasks: readonly RemoteTaskListItem[],
  sortBy: "created" | "updated",
): RemoteTaskListItem[] {
  return sortMobileTasks(
    tasks.filter((task) => task.pinned === true && task.archived !== true),
    sortBy,
  );
}

/** 首页只展示未归档任务（归档能力属桌面任务索引，§7.5）。 */
export function collectVisibleTasks(tasks: readonly RemoteTaskListItem[]): RemoteTaskListItem[] {
  return tasks.filter((task) => task.archived !== true);
}

export function countSummary(tasks: readonly RemoteTaskListItem[], workspaces: readonly RemoteWorkspaceDescriptor[]): {
  taskCount: number;
  workspaceCount: number;
} {
  return {
    taskCount: collectVisibleTasks(tasks).length,
    workspaceCount: workspaces.length,
  };
}

/** 断连判定（§7.4 分组卡）：remote 且 (connectionState=disconnected 或缺 remoteSessionId)。 */
export function isWorkspaceDisconnected(workspace: RemoteWorkspaceDescriptor): boolean {
  if (workspace.kind !== "remote") return false;
  return workspace.connectionState === "disconnected" || !workspace.remoteSessionId?.trim();
}

/** 分组图标（§7.4）：conversation→message-circle-plus、remote→cloud、else folder-open。 */
export function workspaceGroupIcon(
  workspace: RemoteWorkspaceDescriptor,
): "message-circle-plus" | "cloud" | "folder-open" {
  if (workspace.workspacePurpose === "conversation") return "message-circle-plus";
  if (workspace.kind === "remote") return "cloud";
  return "folder-open";
}
