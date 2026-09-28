import { useEffect, useMemo, useState } from "react";
import { ChevronsUp, ListFilter, PanelLeft, RefreshCw, SortAsc } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  RemoteTaskListItem,
  RemoteWorkspaceDescriptor,
} from "@zcode/shared/web-remote-control";
import { MobileTaskRow } from "./MobileTaskRow.js";
import { MobileThemeMenu } from "./MobileThemeMenu.js";
import { MobileWorkspaceGroupCard } from "./MobileWorkspaceGroupCard.js";
import {
  collectPinnedTasks,
  collectVisibleTasks,
  countSummary,
  groupTasksByTimeline,
  groupTasksByWorkspace,
  sortMobileTasks,
  taskWorkspaceKey,
  type MobileTimelineBucket,
} from "./mobileTaskGroups.js";
import type { MobileTaskHomePreferences } from "./mobilePreferences.js";

// 手机端任务首页（附录C §7.4）：header（title+connected+主题菜单）→ notice 卡 →
// 区头（sectionTitle+summary{taskCount,workspaceCount}）→ 工具条（导航面板收起开关
// [webRemoteControl.expandNavigation/collapseNavigation，官方 WorkspaceShellLayout 开关
// aria 同款]/collapseAll[仅 workspace 模式]/organize 菜单 workspace|timeline/
// sortBy 菜单 created|updated/刷新）→ 错误框/loading/空态（noTasks）→
// 置顶区（pinnedSection）→ timeline 分组（taskTimeline.*）或 workspace 分组卡。
// 导航面板 = aside#web-remote-control-navigation-panel（任务和工作区整体折叠），
// 折叠态由 shell（useMobileShellController）持有：打开任务即收起、跨 workspace 打开
// 武装一次性标志、挂载时消费一次——不是工作区分组折叠（工作区分组另有 collapseAll）。

export interface MobileTaskHomeProps {
  workspaces: readonly RemoteWorkspaceDescriptor[];
  tasks: readonly RemoteTaskListItem[];
  loading: boolean;
  errorText?: string | null;
  connected: boolean;
  preferences: MobileTaskHomePreferences;
  onPreferencesChange: (preferences: MobileTaskHomePreferences) => void;
  onOpenTask: (task: RemoteTaskListItem) => void;
  onStartDraft: (workspaceKey: string) => void;
  onReconnectWorkspace: (workspaceKey: string) => void;
  reconnectingWorkspaceKey?: string | null;
  /** 官方 s5t defaultExpandedWorkspaceKeys 的 active 源（styles@3960579）：仅 active 工作区默认展开。 */
  activeWorkspaceKey?: string | null;
  onRefresh: () => void;
  /** 导航面板折叠态（官方 sn/isCollapsed）；开关即 webRemoteControl.expandNavigation/collapseNavigation。 */
  navigationCollapsed: boolean;
  onToggleNavigationCollapsed: () => void;
  /** 注入测试用时钟；缺省 Date.now()。 */
  now?: number;
}

function timelineBucketLabelId(bucket: MobileTimelineBucket): string {
  return `taskTimeline.${bucket.key}`;
}

export function MobileTaskHome({
  workspaces,
  tasks,
  loading,
  errorText,
  connected,
  preferences,
  onPreferencesChange,
  onOpenTask,
  onStartDraft,
  onReconnectWorkspace,
  reconnectingWorkspaceKey,
  activeWorkspaceKey,
  onRefresh,
  navigationCollapsed,
  onToggleNavigationCollapsed,
  now,
}: MobileTaskHomeProps) {
  const { intl, locale } = useZCodeIntl();
  const { formatMessage } = intl;
  const clock = now ?? Date.now();
  const visibleTasks = useMemo(() => collectVisibleTasks(tasks), [tasks]);
  const pinnedTasks = useMemo(
    () => collectPinnedTasks(tasks, preferences.sortBy),
    [tasks, preferences.sortBy],
  );
  const summary = useMemo(() => countSummary(tasks, workspaces), [tasks, workspaces]);
  const workspaceGroups = useMemo(
    () => groupTasksByWorkspace(workspaces, visibleTasks, preferences.sortBy),
    [workspaces, visibleTasks, preferences.sortBy],
  );
  const timelineGroups = useMemo(
    () =>
      // 官方管线 E2→B8t：先全局排序（运行中置顶+降序链），分桶首见序、组内不再排序。
      groupTasksByTimeline(sortMobileTasks(visibleTasks, preferences.sortBy), {
        sortBy: preferences.sortBy,
        now: clock,
        locale,
      }),
    [visibleTasks, clock, locale, preferences.sortBy],
  );

  // 工作区分组展开态（官方 s5t：defaultExpandedWorkspaceKeys = activeInGroups ? {active} : {}，
  // styles@3960579——**仅 active 工作区默认展开**）。null=尚未初始化，首帧按"仅 active"呈现；
  // 用户 toggle/collapseAll 后按用户态走；快照刷新只修剪消失的键，不重置用户态。
  // collapse-navigation-once 不作用于工作区分组（它管的是导航面板整体）。
  const [expandedKeys, setExpandedKeys] = useState<Set<string> | null>(null);

  function isGroupExpanded(workspaceKey: string): boolean {
    if (expandedKeys === null) return workspaceKey === activeWorkspaceKey;
    return expandedKeys.has(workspaceKey);
  }

  const allCollapsed =
    workspaceGroups.length > 0 && workspaceGroups.every((group) => !isGroupExpanded(group.workspaceKey));

  useEffect(() => {
    setExpandedKeys((previous) => {
      const current = new Set(workspaceGroups.map((group) => group.workspaceKey));
      if (previous === null) {
        return new Set(
          activeWorkspaceKey && current.has(activeWorkspaceKey) ? [activeWorkspaceKey] : [],
        );
      }
      const next = new Set(Array.from(previous).filter((key) => current.has(key)));
      return next.size === previous.size ? previous : next;
    });
  }, [workspaceGroups, activeWorkspaceKey]);

  function toggleGroup(workspaceKey: string): void {
    setExpandedKeys((previous) => {
      const base = previous ?? new Set(activeWorkspaceKey ? [activeWorkspaceKey] : []);
      const next = new Set(base);
      if (next.has(workspaceKey)) {
        next.delete(workspaceKey);
      } else {
        next.add(workspaceKey);
      }
      return next;
    });
  }

  function toggleCollapseAll(): void {
    // 工具条按钮是收起全部（§7.4）；已全收起时再次点击展开全部，避免按钮在该状态下无事可做。
    setExpandedKeys(
      allCollapsed
        ? new Set(workspaceGroups.map((group) => group.workspaceKey))
        : new Set<string>(),
    );
  }

  function latestUpdatedAt(workspaceKey: string): number | null {
    let latest: number | null = null;
    for (const task of visibleTasks) {
      if (taskWorkspaceKey(task) !== workspaceKey) continue;
      latest = latest === null ? task.updatedAt : Math.max(latest, task.updatedAt);
    }
    return latest;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-ui-lg font-medium">
            {formatMessage({ id: "webRemoteControl.mobileHome.title" })}
          </h1>
          <p className="truncate text-ui-sm text-foreground-subtle">
            {connected
              ? formatMessage({ id: "webRemoteControl.mobileHome.connected" })
              : formatMessage({ id: "webRemoteControl.mobileShell.reconnecting" })}
          </p>
        </div>
        <MobileThemeMenu />
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        <section className="rounded-xl border border-card-border bg-card px-3 py-2 text-ui-sm text-foreground-subtle">
          {formatMessage({ id: "webRemoteControl.mobileHome.notice" })}
        </section>

        <div className="flex flex-col gap-1">
          <h2 className="text-ui-base font-medium">
            {formatMessage({ id: "webRemoteControl.mobileHome.sectionTitle" })}
          </h2>
          <p className="text-ui-sm text-foreground-subtle">
            {formatMessage(
              { id: "webRemoteControl.mobileHome.summary" },
              { taskCount: summary.taskCount, workspaceCount: summary.workspaceCount },
            )}
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-expanded={!navigationCollapsed}
            aria-controls="web-remote-control-navigation-panel"
            aria-label={formatMessage({
              id: navigationCollapsed
                ? "webRemoteControl.expandNavigation"
                : "webRemoteControl.collapseNavigation",
            })}
            title={formatMessage({
              id: navigationCollapsed
                ? "webRemoteControl.expandNavigation"
                : "webRemoteControl.collapseNavigation",
            })}
            onClick={onToggleNavigationCollapsed}
          >
            <PanelLeft className="size-3.5" />
          </Button>
          {preferences.organizeBy === "workspace" ? (
            <Button type="button" variant="outline" size="sm" onClick={toggleCollapseAll}>
              <ChevronsUp className="size-3" />
              {formatMessage({ id: "webRemoteControl.mobileHome.collapseAll" })}
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                <ListFilter className="size-3" />
                {formatMessage({ id: "webRemoteControl.mobileHome.organize" })}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-40">
              <DropdownMenuRadioGroup
                value={preferences.organizeBy}
                onValueChange={(value) => {
                  if (value === "workspace" || value === "timeline") {
                    onPreferencesChange({ ...preferences, organizeBy: value });
                  }
                }}
              >
                <DropdownMenuRadioItem value="workspace">
                  {formatMessage({ id: "webRemoteControl.mobileHome.organizeByWorkspace" })}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="timeline">
                  {formatMessage({ id: "webRemoteControl.mobileHome.organizeByTimeline" })}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                <SortAsc className="size-3" />
                {formatMessage({ id: "webRemoteControl.mobileHome.sortBy" })}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-40">
              <DropdownMenuRadioGroup
                value={preferences.sortBy}
                onValueChange={(value) => {
                  if (value === "created" || value === "updated") {
                    onPreferencesChange({ ...preferences, sortBy: value });
                  }
                }}
              >
                <DropdownMenuRadioItem value="created">
                  {formatMessage({ id: "webRemoteControl.mobileHome.sortByCreated" })}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="updated">
                  {formatMessage({ id: "webRemoteControl.mobileHome.sortByUpdated" })}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={formatMessage({ id: "webRemoteControl.mobileHome.refresh" })}
            title={formatMessage({ id: "webRemoteControl.mobileHome.refresh" })}
            onClick={onRefresh}
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </div>

        {errorText ? (
          <div className="rounded-xl border border-destructive bg-card px-3 py-2 text-ui-sm text-destructive">
            {errorText}
          </div>
        ) : null}
        {loading ? (
          <div className="flex items-center gap-2 px-1 text-ui-sm text-foreground-subtle">
            <Spinner className="size-4" />
            {formatMessage({ id: "common.loading" })}
          </div>
        ) : null}
        {!loading && visibleTasks.length === 0 ? (
          <p className="px-1 py-2 text-ui-sm text-foreground-subtlest">
            {formatMessage({ id: "webRemoteControl.noTasks" })}
          </p>
        ) : null}

        {/* 导航面板（官方 aside#web-remote-control-navigation-panel）：任务和工作区整体折叠。 */}
        <div
          id="web-remote-control-navigation-panel"
          className={cn("flex flex-col gap-3", navigationCollapsed && "hidden")}
        >
          {pinnedTasks.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h3 className="px-1 text-ui-sm font-medium text-foreground-subtle">
                {formatMessage({ id: "taskList.pinnedSection" })}
              </h3>
              {pinnedTasks.map((task) => (
                <MobileTaskRow key={task.taskId} task={task} sortBy={preferences.sortBy} onOpen={onOpenTask} />
              ))}
            </section>
          ) : null}

          {preferences.organizeBy === "timeline"
            ? timelineGroups.map((group) => (
                <section key={`${group.bucket.key}:${group.bucket.days ?? ""}`} className="flex flex-col gap-2">
                  <h3 className="px-1 text-ui-sm font-medium text-foreground-subtle">
                    {formatMessage(
                      { id: timelineBucketLabelId(group.bucket) },
                      group.bucket.days == null ? undefined : { days: group.bucket.days },
                    )}
                  </h3>
                  {group.tasks.map((task) => (
                    <MobileTaskRow key={task.taskId} task={task} sortBy={preferences.sortBy} onOpen={onOpenTask} />
                  ))}
                </section>
              ))
            : workspaceGroups.map((group) => (
                <MobileWorkspaceGroupCard
                  key={group.workspaceKey}
                  group={group}
                  expanded={isGroupExpanded(group.workspaceKey)}
                  reconnecting={reconnectingWorkspaceKey === group.workspaceKey}
                  latestUpdatedAt={latestUpdatedAt(group.workspaceKey)}
                  onToggleExpanded={() => toggleGroup(group.workspaceKey)}
                  onStartDraft={onStartDraft}
                  onReconnect={onReconnectWorkspace}
                >
                  {group.tasks.map((task) => (
                    <MobileTaskRow key={task.taskId} task={task} sortBy={preferences.sortBy} onOpen={onOpenTask} />
                  ))}
                </MobileWorkspaceGroupCard>
              ))}
        </div>
      </div>
    </div>
  );
}
