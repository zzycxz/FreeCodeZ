// 源码保真回归（ZCode 3.14.3 反编译 styles-DEELZGp2.js 为唯一裁决锚）：
//  1) timeline 分桶 = 官方 L8t（@3955238）+ w2/F8t/I8t：日差 floor、本地午夜对齐、daysAgo 上界 3、
//     周/月界为日0点 >= 比较、周起始 locale 精确匹配 'en-US'；
//  2) collapse-navigation-once = 官方 Zvn/Qvn（f5@5176968，读写@5178217）：sessionStorage 一次性
//     标志，读到 "1" 即 removeItem 消费；写入在跨 workspace 导航；作用对象是导航面板；
//  3) displayStatus 归并 = 官方 J8t（@3956787）∘ q8t（@3956592）∘ V8t（@3956093）完整优先链。
// 另含既有 mobile 纯函数回归（偏好解析/读写、分组/排序/状态 pill 等），防止本次改写误伤。
// 运行:cd packages/ui && node --import tsx --test test/mobileSourceFidelity.test.ts
import assert from "node:assert/strict";
import test from "node:test";

import type { RemoteTaskListItem, RemoteWorkspaceDescriptor } from "@zcode/shared/web-remote-control";
import {
  armCollapseNavigationOnce,
  consumeCollapseNavigationOnce,
  MOBILE_COLLAPSE_NAVIGATION_ONCE_KEY,
  MOBILE_TASK_HOME_PREFERENCES_KEY,
  parseMobileTaskHomePreferences,
  readMobileTaskHomePreferences,
  serializeMobileTaskHomePreferences,
  writeMobileTaskHomePreferences,
  DEFAULT_MOBILE_TASK_HOME_PREFERENCES,
  type MobileTaskHomePreferences,
  type StorageLike,
} from "../src/mobile/mobilePreferences.js";
import {
  collectPinnedTasks,
  collectVisibleTasks,
  compareTasksForSort,
  countSummary,
  groupTasksByTimeline,
  groupTasksByWorkspace,
  isRuntimeRunningStatus,
  isTaskUnread,
  isWorkspaceDisconnected,
  mapTaskPhaseToDisplayStatus,
  mergeTaskDisplayStatus,
  sortMobileTasks,
  taskStatusPill,
  taskWorkspaceKey,
  timelineBucketFor,
  workspaceGroupIcon,
  workspaceGroupKey,
} from "../src/mobile/mobileTaskGroups.js";

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function makeTask(overrides: Partial<RemoteTaskListItem> = {}): RemoteTaskListItem {
  return {
    taskId: "task-1",
    title: "任务",
    workspacePath: "/ws/a",
    workspaceLabel: "a",
    workspaceKind: "local",
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

// ───────────────────────── 1) timeline 分桶（官方 L8t） ─────────────────────────

// 固定“现在”：2026-09-27（周日）15:30 本地时间；所有断言日期用 Date(y,m,d) 本地构造，跨时区稳定。
const NOW = new Date(2026, 8, 27, 15, 30).getTime();
const at = (month: number, day: number, hour = 12, minute = 0): number =>
  new Date(2026, month - 1, day, hour, minute).getTime();

test("L8t 分桶：today 含当日任意时刻与未来时间戳（a<=0）", () => {
  assert.deepEqual(timelineBucketFor(at(9, 27, 0, 0), NOW, "zh-CN"), { key: "today" });
  assert.deepEqual(timelineBucketFor(at(9, 27, 23, 59), NOW, "zh-CN"), { key: "today" });
  // 未来：日差 < 0 同样落 today（官方 a<=0）
  assert.deepEqual(timelineBucketFor(new Date(2026, 8, 28, 3, 0).getTime(), NOW, "zh-CN"), { key: "today" });
});

test("L8t 分桶：yesterday 按本地午夜切分，不是滚动 24h", () => {
  assert.deepEqual(timelineBucketFor(at(9, 26, 23, 59), NOW, "zh-CN"), { key: "yesterday" });
  assert.deepEqual(timelineBucketFor(at(9, 26, 0, 0), NOW, "zh-CN"), { key: "yesterday" });
});

test("L8t 分桶：daysAgo 上界为 3（仅 2/3 天前），4 天前起走周界", () => {
  assert.deepEqual(timelineBucketFor(at(9, 25), NOW, "zh-CN"), { key: "daysAgo", days: 2 });
  assert.deepEqual(timelineBucketFor(at(9, 24), NOW, "zh-CN"), { key: "daysAgo", days: 3 });
  // 4 天前不属于 daysAgo（旧实现误用上界 6）；周日的 now 下周一始周包含它 → thisWeek
  assert.deepEqual(timelineBucketFor(at(9, 23), NOW, "zh-CN"), { key: "thisWeek" });
});

test("L8t 分桶：周界为日0点 >= 比较（zh-CN 周一起始）", () => {
  // 本周起点 = 2026-09-21（周一）00:00
  assert.deepEqual(timelineBucketFor(at(9, 21, 0, 0), NOW, "zh-CN"), { key: "thisWeek" });
  assert.deepEqual(timelineBucketFor(at(9, 22), NOW, "zh-CN"), { key: "thisWeek" });
  // 上周起点 = 2026-09-14（周一）00:00
  assert.deepEqual(timelineBucketFor(at(9, 20), NOW, "zh-CN"), { key: "lastWeek" });
  assert.deepEqual(timelineBucketFor(at(9, 14, 0, 0), NOW, "zh-CN"), { key: "lastWeek" });
});

test("L8t 分桶：周起始按 locale 精确匹配 'en-US'=周日，其余=周一（含大小写敏感）", () => {
  // en-US 周起始 = 2026-09-27（周日，now 当天）→ 9/23 落在上周
  assert.deepEqual(timelineBucketFor(at(9, 23), NOW, "en-US"), { key: "lastWeek" });
  // 9/20 落在上一周区间 [9/20, 9/26] → lastWeek
  assert.deepEqual(timelineBucketFor(at(9, 20), NOW, "en-US"), { key: "lastWeek" });
  // 9/14 在 en-US 下出了周界 → 月界 thisMonth（zh-CN 下是 lastWeek）
  assert.deepEqual(timelineBucketFor(at(9, 14, 0, 0), NOW, "en-US"), { key: "thisMonth" });
  // 非精确 'en-US' 一律周一：en-us / en / zh-CN 同链
  assert.deepEqual(timelineBucketFor(at(9, 23), NOW, "en-us"), { key: "thisWeek" });
  assert.deepEqual(timelineBucketFor(at(9, 23), NOW, "en"), { key: "thisWeek" });
  assert.deepEqual(timelineBucketFor(at(9, 23), NOW, "en_US"), { key: "thisWeek" });
});

test("L8t 分桶：月界为日0点 >= 比较（本月1日/上月1日边界）", () => {
  // 本月起点 = 2026-09-01 00:00（差 14 天以上，早于上周界）
  assert.deepEqual(timelineBucketFor(at(9, 1, 0, 0), NOW, "zh-CN"), { key: "thisMonth" });
  assert.deepEqual(timelineBucketFor(at(9, 13), NOW, "zh-CN"), { key: "thisMonth" });
  // 上月起点 = 2026-08-01 00:00
  assert.deepEqual(timelineBucketFor(at(8, 31), NOW, "zh-CN"), { key: "lastMonth" });
  assert.deepEqual(timelineBucketFor(at(8, 1, 0, 0), NOW, "zh-CN"), { key: "lastMonth" });
  // 更早 → older
  assert.deepEqual(timelineBucketFor(at(7, 31), NOW, "zh-CN"), { key: "older" });
});

test("groupTasksByTimeline（B8t）：首见序分桶、组内保持遇序不排序", () => {
  const tasks = [
    makeTask({ taskId: "a", createdAt: at(9, 24), updatedAt: at(9, 24) }), // daysAgo 3
    makeTask({ taskId: "b", createdAt: at(9, 25), updatedAt: at(9, 25) }), // daysAgo 2
    makeTask({ taskId: "c", createdAt: at(9, 25, 9), updatedAt: at(9, 25, 9) }), // daysAgo 2
  ];
  // B8t 逐字节：按输入遇序 append，组序=首见序，组内不再排序（旧实现按 TIMELINE_ORDER 重排+组内排序，被源码推翻）
  const groups = groupTasksByTimeline(tasks, { sortBy: "created", now: NOW, locale: "zh-CN" });
  assert.deepEqual(
    groups.map((group) => [group.bucket, group.tasks.map((task) => task.taskId)]),
    [
      [{ key: "daysAgo", days: 3 }, ["a"]],
      [{ key: "daysAgo", days: 2 }, ["b", "c"]],
    ],
  );
  // 官方管线 E2→B8t：先 sortMobileTasks（created 降序）再分桶，组序随输入为 d2 组在前、组内遇序
  //（b=12 点默认时、c=9 点，降序后 b 前 c 后）
  const pipeline = groupTasksByTimeline(sortMobileTasks(tasks, "created"), {
    sortBy: "created",
    now: NOW,
    locale: "zh-CN",
  });
  assert.deepEqual(
    pipeline.map((group) => [group.bucket, group.tasks.map((task) => task.taskId)]),
    [
      [{ key: "daysAgo", days: 2 }, ["b", "c"]],
      [{ key: "daysAgo", days: 3 }, ["a"]],
    ],
  );
});

// ─────────────────── 1b) 排序（官方 Wu∘fue∘H8t，styles@145385/145078/3956152） ───────────────────

test("H8t 置顶：displayStatus=running 或 hasBackgroundWork 在前；双置顶按 createdAt 降序", () => {
  const top = makeTask({ taskId: "top", createdAt: at(9, 1), updatedAt: at(9, 1), displayStatus: "running" });
  const bg = makeTask({ taskId: "bg", createdAt: at(9, 2), updatedAt: at(9, 2), hasBackgroundWork: true });
  const plain = makeTask({ taskId: "plain", createdAt: at(9, 27), updatedAt: at(9, 27) });
  // 双置顶：createdAt 降序（bg 9/2 前于 top 9/1）；非置顶 plain 即使更新最新也垫底
  assert.deepEqual(
    sortMobileTasks([plain, bg, top], "updated").map((task) => task.taskId),
    ["bg", "top", "plain"],
  );
});

test("Wu 双置顶分支不查 updatedAt：createdAt 同 → taskId localeCompare 降序", () => {
  const a = makeTask({ taskId: "a1", createdAt: at(9, 5), updatedAt: at(9, 1), displayStatus: "running" });
  const b = makeTask({ taskId: "b1", createdAt: at(9, 5), updatedAt: at(9, 27), displayStatus: "running" });
  // updatedAt 差异大但双置顶分支忽略之；b1.localeCompare(a1)>0 → b1 在前
  assert.deepEqual(sortMobileTasks([a, b], "updated").map((task) => task.taskId), ["b1", "a1"]);
  assert.deepEqual(sortMobileTasks([a, b], "created").map((task) => task.taskId), ["b1", "a1"]);
});

test("fue 全链（双非置顶）：created=createdAt→updatedAt→taskId 全降序；updated=updatedAt→createdAt→taskId", () => {
  const t1 = makeTask({ taskId: "t1", createdAt: at(9, 5), updatedAt: at(9, 10) });
  const t2 = makeTask({ taskId: "t2", createdAt: at(9, 5), updatedAt: at(9, 10) });
  // created 同 + updated 同 → taskId localeCompare 降序：t2 在前
  assert.deepEqual(sortMobileTasks([t1, t2], "created").map((task) => task.taskId), ["t2", "t1"]);
  // created 同 → updatedAt 降序
  const u1 = makeTask({ taskId: "u1", createdAt: at(9, 5), updatedAt: at(9, 3) });
  const u2 = makeTask({ taskId: "u2", createdAt: at(9, 5), updatedAt: at(9, 9) });
  assert.deepEqual(sortMobileTasks([u1, u2], "created").map((task) => task.taskId), ["u2", "u1"]);
  // updated 同 → createdAt 降序
  const c1 = makeTask({ taskId: "c1", createdAt: at(9, 2), updatedAt: at(9, 9) });
  const c2 = makeTask({ taskId: "c2", createdAt: at(9, 6), updatedAt: at(9, 9) });
  assert.deepEqual(sortMobileTasks([c1, c2], "updated").map((task) => task.taskId), ["c2", "c1"]);
});

// ─────────────────── 2) collapse-navigation-once（官方 Zvn/Qvn，f5） ───────────────────

test("Zvn 语义：读到 '1' 即 removeItem 消费并返回 true，一次性", () => {
  const storage = fakeStorage();
  armCollapseNavigationOnce(storage);
  assert.equal(storage.data.get(MOBILE_COLLAPSE_NAVIGATION_ONCE_KEY), "1");
  assert.equal(consumeCollapseNavigationOnce(storage), true);
  // 读取后即清除：第二次不再命中
  assert.equal(storage.data.get(MOBILE_COLLAPSE_NAVIGATION_ONCE_KEY), undefined);
  assert.equal(consumeCollapseNavigationOnce(storage), false);
});

test("Zvn 语义：未武装不收起（与旧推断相反：不是『首次进入写 key 并收起』）", () => {
  const storage = fakeStorage();
  assert.equal(consumeCollapseNavigationOnce(storage), false);
  // 消费动作本身不得写 key
  assert.equal(storage.data.get(MOBILE_COLLAPSE_NAVIGATION_ONCE_KEY), undefined);
});

test("Zvn 语义：值非 '1' 不命中；重复武装也只消费一次", () => {
  const storage = fakeStorage({ [MOBILE_COLLAPSE_NAVIGATION_ONCE_KEY]: "0" });
  assert.equal(consumeCollapseNavigationOnce(storage), false);
  armCollapseNavigationOnce(storage);
  armCollapseNavigationOnce(storage);
  assert.equal(consumeCollapseNavigationOnce(storage), true);
  assert.equal(consumeCollapseNavigationOnce(storage), false);
});

test("Zvn/Qvn 异常路径：读异常返回 false（官方 catch 后 return !1），写异常静默", () => {
  const broken: StorageLike = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(consumeCollapseNavigationOnce(broken), false);
  armCollapseNavigationOnce(broken);
});

// ─────────────── 3) displayStatus 归并（官方 J8t ∘ q8t ∘ V8t） ───────────────

test("q8t 映射表：prewarming|running→running、completedSuccess|completedInterrupted→completed、error→error、draft→落空", () => {
  assert.equal(mapTaskPhaseToDisplayStatus("prewarming"), "running");
  assert.equal(mapTaskPhaseToDisplayStatus("running"), "running");
  assert.equal(mapTaskPhaseToDisplayStatus("completedSuccess"), "completed");
  assert.equal(mapTaskPhaseToDisplayStatus("completedInterrupted"), "completed");
  assert.equal(mapTaskPhaseToDisplayStatus("error"), "error");
  // draft 显式返回 undefined → J8t 续走 runtime 链
  assert.equal(mapTaskPhaseToDisplayStatus("draft"), undefined);
  // 枚举外原样透传（官方尾部 `return e`）、缺省 undefined
  assert.equal(mapTaskPhaseToDisplayStatus("weird-phase"), "weird-phase");
  assert.equal(mapTaskPhaseToDisplayStatus(undefined), undefined);
});

test("V8t 判定：仅 creating|streaming 算在跑（restoring 不算）", () => {
  assert.equal(isRuntimeRunningStatus("creating"), true);
  assert.equal(isRuntimeRunningStatus("streaming"), true);
  assert.equal(isRuntimeRunningStatus("restoring"), false);
  assert.equal(isRuntimeRunningStatus("failed"), false);
  assert.equal(isRuntimeRunningStatus("completed"), false);
  assert.equal(isRuntimeRunningStatus(undefined), false);
});

test("J8t 优先链①：活性 phase 优先于 runtimeStatus 与 task.status", () => {
  assert.equal(
    mergeTaskDisplayStatus({
      task: { __zcodeSessionActivity: { phase: "running" }, status: "error" },
      runtimeStatus: "failed",
    }),
    "running",
  );
  assert.equal(
    mergeTaskDisplayStatus({
      task: { __zcodeSessionActivity: { phase: "completedSuccess" }, status: "error" },
      runtimeStatus: "failed",
    }),
    "completed",
  );
  assert.equal(
    mergeTaskDisplayStatus({
      task: { __zcodeSessionActivity: { phase: "error" }, status: "completed" },
      runtimeStatus: "completed",
    }),
    "error",
  );
});

test("J8t 优先链②：draft/缺 phase 落空续走 runtime 链，再走 task.status，最后 idle", () => {
  // draft → runtime 判定
  assert.equal(
    mergeTaskDisplayStatus({
      task: { __zcodeSessionActivity: { phase: "draft" } },
      runtimeStatus: "streaming",
    }),
    "running",
  );
  assert.equal(
    mergeTaskDisplayStatus({
      task: { __zcodeSessionActivity: { phase: "draft" }, status: "completed" },
      runtimeStatus: "failed",
    }),
    "error",
  );
  // draft → 无 runtime → task.status
  assert.equal(
    mergeTaskDisplayStatus({ task: { __zcodeSessionActivity: { phase: "draft" }, status: "completed" } }),
    "completed",
  );
  // draft → 全空 → idle
  assert.equal(mergeTaskDisplayStatus({ task: { __zcodeSessionActivity: { phase: "draft" } } }), "idle");
  // 活性在场但 phase 缺失 → q8t(undefined) 落空续走
  assert.equal(
    mergeTaskDisplayStatus({ task: { __zcodeSessionActivity: {}, status: "error" }, runtimeStatus: undefined }),
    "error",
  );
});

test("J8t 优先链③：runtimeStatus 表（creating|streaming→running、failed→error、completed→completed）", () => {
  assert.equal(mergeTaskDisplayStatus({ task: {}, runtimeStatus: "creating" }), "running");
  assert.equal(mergeTaskDisplayStatus({ task: {}, runtimeStatus: "streaming" }), "running");
  // restoring 不在 V8t → 落到末档 idle
  assert.equal(mergeTaskDisplayStatus({ task: {}, runtimeStatus: "restoring" }), "idle");
  // runtime failed 先于 task.status completed
  assert.equal(
    mergeTaskDisplayStatus({ task: { status: "completed" }, runtimeStatus: "failed" }),
    "error",
  );
  assert.equal(mergeTaskDisplayStatus({ task: {}, runtimeStatus: "failed" }), "error");
  assert.equal(mergeTaskDisplayStatus({ task: {}, runtimeStatus: "completed" }), "completed");
});

test("J8t 优先链④：task.status 表（error→error、completed→completed、running→idle）", () => {
  assert.equal(mergeTaskDisplayStatus({ task: { status: "error" } }), "error");
  assert.equal(mergeTaskDisplayStatus({ task: { status: "completed" } }), "completed");
  // 持久态 running 但无活性/无 runtime → 官方落 idle
  assert.equal(mergeTaskDisplayStatus({ task: { status: "running" } }), "idle");
  assert.equal(mergeTaskDisplayStatus({ task: {} }), "idle");
});

// ─────────────── 既有 mobile 纯函数回归（防止本次改写误伤） ───────────────

test("回归：偏好解析两字段同时合法才接受，否则整体回退默认值", () => {
  assert.deepEqual(parseMobileTaskHomePreferences(null), DEFAULT_MOBILE_TASK_HOME_PREFERENCES);
  assert.deepEqual(parseMobileTaskHomePreferences("not-json"), DEFAULT_MOBILE_TASK_HOME_PREFERENCES);
  assert.deepEqual(parseMobileTaskHomePreferences("[]"), DEFAULT_MOBILE_TASK_HOME_PREFERENCES);
  assert.deepEqual(
    parseMobileTaskHomePreferences(JSON.stringify({ organizeBy: "timeline", sortBy: "nonsense" })),
    DEFAULT_MOBILE_TASK_HOME_PREFERENCES,
  );
  assert.deepEqual(
    parseMobileTaskHomePreferences(JSON.stringify({ organizeBy: "project", sortBy: "created" })),
    DEFAULT_MOBILE_TASK_HOME_PREFERENCES,
  );
  assert.deepEqual(
    parseMobileTaskHomePreferences(JSON.stringify({ sortBy: "created" })),
    DEFAULT_MOBILE_TASK_HOME_PREFERENCES,
  );
  assert.deepEqual(parseMobileTaskHomePreferences('{"organizeBy":"timeline","sortBy":"created"}'), {
    organizeBy: "timeline",
    sortBy: "created",
  });
});

test("回归：偏好读写 roundtrip 稳定，storage 异常静默回退", () => {
  const storage = fakeStorage();
  const preferences: MobileTaskHomePreferences = { organizeBy: "timeline", sortBy: "created" };
  writeMobileTaskHomePreferences(storage, preferences);
  assert.equal(storage.data.get(MOBILE_TASK_HOME_PREFERENCES_KEY), serializeMobileTaskHomePreferences(preferences));
  assert.deepEqual(readMobileTaskHomePreferences(storage), preferences);

  const broken: StorageLike = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  assert.deepEqual(readMobileTaskHomePreferences(broken), DEFAULT_MOBILE_TASK_HOME_PREFERENCES);
  writeMobileTaskHomePreferences(broken, preferences);
});

test("回归：workspace 分组/排序/身份键/未读/置顶可见性", () => {
  const workspaces: RemoteWorkspaceDescriptor[] = [
    { workspacePath: "/ws/a", label: "a", kind: "local" },
    { workspacePath: "/ws/b", label: "b", kind: "remote", remoteSessionId: "rs-1", workspaceIdentity: "id-b" },
  ];
  const tasks = [
    makeTask({ taskId: "t1", workspacePath: "/ws/a", createdAt: 1, updatedAt: 9 }),
    makeTask({ taskId: "t2", workspacePath: "/ws/a", createdAt: 2, updatedAt: 8, unreadAt: 5 }),
    makeTask({ taskId: "t3", workspacePath: "/ws/b", workspaceIdentity: "id-b", createdAt: 3, updatedAt: 7, pinned: true }),
    makeTask({ taskId: "t4", workspacePath: "/ws/a", createdAt: 4, updatedAt: 6, archived: true }),
  ];
  const groups = groupTasksByWorkspace(workspaces, collectVisibleTasks(tasks), "updated");
  assert.deepEqual(groups.map((group) => group.tasks.map((task) => task.taskId)), [["t1", "t2"], ["t3"]]);
  assert.deepEqual(groups.map((group) => group.hasUnread), [true, false]);
  assert.deepEqual(collectPinnedTasks(tasks, "updated").map((task) => task.taskId), ["t3"]);
  assert.deepEqual(countSummary(tasks, workspaces), { taskCount: 3, workspaceCount: 2 });
  assert.equal(compareTasksForSort(tasks[0], tasks[1], "updated"), -1); // updatedAt 降序
  assert.equal(isTaskUnread(tasks[1]), true);
  assert.equal(isTaskUnread(tasks[0]), false);
  assert.equal(taskWorkspaceKey(tasks[2]), "id-b"); // identity 优先
  assert.equal(taskWorkspaceKey(tasks[0]), "/ws/a"); // 本地回退 path
  assert.equal(workspaceGroupKey(workspaces[1]), "id-b");
});

test("回归：状态 pill/断连/分组图标", () => {
  assert.deepEqual(taskStatusPill("running").status, "running");
  assert.deepEqual(taskStatusPill("completed").icon, "circle-check");
  assert.deepEqual(taskStatusPill("error").icon, "circle-alert");
  assert.deepEqual(taskStatusPill(undefined).status, "idle");
  assert.equal(
    isWorkspaceDisconnected({ workspacePath: "/r", label: "r", kind: "remote", remoteSessionId: "rs" }),
    false,
  );
  assert.equal(isWorkspaceDisconnected({ workspacePath: "/r", label: "r", kind: "remote" }), true);
  assert.equal(workspaceGroupIcon({ workspacePath: "/c", label: "c", kind: "local", workspacePurpose: "conversation" }), "message-circle-plus");
  assert.equal(workspaceGroupIcon({ workspacePath: "/r", label: "r", kind: "remote", remoteSessionId: "rs" }), "cloud");
  assert.equal(workspaceGroupIcon({ workspacePath: "/l", label: "l", kind: "local" }), "folder-open");
});
