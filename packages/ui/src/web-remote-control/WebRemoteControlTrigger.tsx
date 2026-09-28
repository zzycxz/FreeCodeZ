/* eslint-disable max-lines -- 触发按钮与窗口快照同步共享同一挂载点，拆开会让快照时序与入口可见性脱钩。 */
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type {
  RemoteTaskListItem,
  RemoteWorkspaceDescriptor,
} from "@zcode/shared/web-remote-control";
import { Smartphone } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import { WebRemoteControlDialog } from "@/web-remote-control/WebRemoteControlDialog.js";
import { mergeTaskDisplayStatus } from "@/mobile/mobileTaskGroups.js";
import {
  getWebRemoteControlBridge,
  useWebRemoteControlStatus,
  type WebRemoteControlStatusSnapshot,
} from "@/web-remote-control/useWebRemoteControlStatus.js";

const LOG_SCOPE = "[WorkspaceWebRemoteControlTrigger]";

/** 触发按钮六态（附录C §1.1 `vin`）：颜色随状态，tooltip 给出可读文案。 */
function resolveTriggerStatusPresentation(
  status: WebRemoteControlStatusSnapshot,
  formatMessage: IntlInstance["formatMessage"],
): { iconClassName: string; tooltip: string } {
  switch (status.status) {
    case "error":
      return {
        iconClassName: "text-destructive",
        tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.error" }),
      };
    case "active":
      return {
        iconClassName: "text-success",
        tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.connected" }),
      };
    case "starting":
      return {
        iconClassName: "text-warning",
        tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.starting" }),
      };
    case "connecting":
      return {
        iconClassName: "text-warning",
        tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.connecting" }),
      };
    case "running":
      return {
        iconClassName: "text-warning",
        tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.waiting" }),
      };
    default:
      return {
        iconClassName: "text-foreground-subtle",
        tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.idle" }),
      };
  }
}

const PROVIDER_VALUES = new Set(["claude", "opencode", "gemini", "codex", "glm"]);

/**
 * liveStatus(投影词表 idle|running|waiting|completed|error，附录A §4.4 TaskFact)
 * → J8t 的 runtimeStatus 词表(creating|streaming|failed|completed)语义桥。
 * 官方 T2 直接持有 taskRuntimeByTaskId 原始词表；本投影面只出 liveStatus，
 * 按语义映射后走 J8t 原链，其余值落空交 task.status 链（与官方未知值同行为）。
 */
function mapTaskLiveStatusToRuntimeStatus(
  value: unknown,
): "streaming" | "failed" | "completed" | undefined {
  if (value === "running") return "streaming";
  if (value === "error") return "failed";
  if (value === "completed") return "completed";
  return undefined;
}

function normalizeProvider(value: unknown): RemoteTaskListItem["provider"] {
  return typeof value === "string" && PROVIDER_VALUES.has(value)
    ? (value as RemoteTaskListItem["provider"])
    : undefined;
}

function normalizeWorkspacePurpose(
  value: string | undefined,
): RemoteWorkspaceDescriptor["workspacePurpose"] {
  return value === "project" || value === "conversation" ? value : undefined;
}

function buildWorkspaceDescriptors(
  tabs: readonly WorkspaceTabState[],
): RemoteWorkspaceDescriptor[] {
  return tabs.map((tab) => {
    const workspaceIdentity = tab.workspaceIdentity?.trim() || undefined;
    return {
      workspacePath: tab.workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
      label: tab.label?.trim() || getPathLeaf(tab.workspacePath),
      ...(normalizeWorkspacePurpose(tab.workspacePurpose)
        ? { workspacePurpose: normalizeWorkspacePurpose(tab.workspacePurpose) }
        : {}),
      kind: workspaceIdentity ? "remote" : "local",
      // 远程 tab 启动期会以"断开占位"恢复（有 identity 无 remoteSessionId）。
      ...(workspaceIdentity
        ? {
            connectionState: tab.remoteSessionId
              ? ("connected" as const)
              : ("disconnected" as const),
          }
        : {}),
    } satisfies RemoteWorkspaceDescriptor;
  });
}

interface SnapshotTaskInput {
  taskId: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  createdAt: number;
  updatedAt: number;
  provider?: unknown;
  unreadAt?: number;
  liveStatus?: unknown;
  status?: unknown;
  remoteSessionId?: string;
  /** attachTaskListRowActivity 附着的会话活性（官方 Vu=task.__zcodeSessionActivity，J8t 首选输入）。 */
  __zcodeSessionActivity?: { phase?: string | null } | null;
}

function buildRemoteTaskListItem(
  task: SnapshotTaskInput,
  options: {
    workspaceLabelByKey: ReadonlyMap<string, string>;
    remoteSessionIdByWorkspaceKey: ReadonlyMap<string, string>;
    pinned: boolean;
    archived: boolean;
  },
): RemoteTaskListItem | null {
  if (!task.taskId.trim() || !task.workspacePath.trim()) {
    return null;
  }
  const workspaceIdentity = task.workspaceIdentity?.trim() || undefined;
  const workspaceKey = workspaceIdentity || task.workspacePath;
  const remoteSessionId =
    task.remoteSessionId?.trim() ||
    options.remoteSessionIdByWorkspaceKey.get(workspaceKey) ||
    undefined;
  const displayStatus =
    mergeTaskDisplayStatus({
      task: {
        ...(task.__zcodeSessionActivity
          ? { __zcodeSessionActivity: task.__zcodeSessionActivity }
          : {}),
        ...(typeof task.status === "string" ? { status: task.status } : {}),
      },
      runtimeStatus: mapTaskLiveStatusToRuntimeStatus(task.liveStatus),
    });
  return {
    taskId: task.taskId,
    title: task.title,
    workspacePath: task.workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    workspaceLabel:
      options.workspaceLabelByKey.get(workspaceKey) || getPathLeaf(task.workspacePath),
    workspaceKind: workspaceIdentity ? "remote" : "local",
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(normalizeProvider(task.provider) ? { provider: normalizeProvider(task.provider) } : {}),
    ...(typeof task.unreadAt === "number" ? { unreadAt: task.unreadAt } : {}),
    ...(displayStatus ? { displayStatus } : {}),
    pinned: options.pinned,
    archived: options.archived,
  };
}

/**
 * 窗口 workspace/任务快照同步（spec §4 接口、附录C §2 syncWebRemoteControl*）。
 * 手机 bootstrap / workspace-list 只能拿到当前窗口集合，所以快照来源就是本窗口的 tab 集合
 * 与 pinned/timeline/archived 三份列表；feature gate 与 syncWindowTabs 同为 isDesktop。
 */
export function WebRemoteControlSnapshotSync({ enabled }: { enabled: boolean }) {
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(
    () => (enabled ? tabs.filter(isWorkspaceTab) : []),
    [enabled, tabs],
  );
  const workspaceTabsKey = useMemo(
    () =>
      workspaceTabs
        .map(
          (tab) =>
            `${tab.workspaceIdentity?.trim() || tab.workspacePath}\u0000${tab.workspacePath}`,
        )
        .join("\u0001"),
    [workspaceTabs],
  );
  const pinnedRead = useGlobalTaskList({
    kind: "pinned",
    workspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 20,
  });
  const timelineRead = useGlobalTaskList({
    kind: "timeline",
    workspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 20,
  });
  const archivedRead = useGlobalTaskList({
    kind: "archived",
    workspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 20,
  });

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const bridge = getWebRemoteControlBridge();
    if (!bridge?.syncWebRemoteControlWorkspaces) {
      return;
    }
    try {
      bridge.syncWebRemoteControlWorkspaces(buildWorkspaceDescriptors(workspaceTabs));
    } catch (error) {
      logger.warn(
        `${LOG_SCOPE} 同步工作区快照失败`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [enabled, workspaceTabs, workspaceTabsKey]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const bridge = getWebRemoteControlBridge();
    if (!bridge?.syncWebRemoteControlTasks) {
      return;
    }
    const workspaceLabelByKey = new Map<string, string>();
    const remoteSessionIdByWorkspaceKey = new Map<string, string>();
    for (const tab of workspaceTabs) {
      const workspaceKey = tab.workspaceIdentity?.trim() || tab.workspacePath;
      workspaceLabelByKey.set(workspaceKey, tab.label?.trim() || getPathLeaf(tab.workspacePath));
      if (tab.remoteSessionId) {
        remoteSessionIdByWorkspaceKey.set(workspaceKey, tab.remoteSessionId);
      }
    }
    const merged = new Map<string, RemoteTaskListItem>();
    const append = (
      items: readonly SnapshotTaskInput[],
      flags: { pinned: boolean; archived: boolean },
    ) => {
      for (const item of items) {
        const task = buildRemoteTaskListItem(item, {
          workspaceLabelByKey,
          remoteSessionIdByWorkspaceKey,
          ...flags,
        });
        if (!task) {
          continue;
        }
        const previous = merged.get(task.taskId);
        // pinned/timeline 两份列表会重复返回同一任务；标记取并集，元数据取先到的一份。
        merged.set(
          task.taskId,
          previous
            ? {
                ...previous,
                pinned: previous.pinned || task.pinned,
                archived: previous.archived || task.archived,
              }
            : task,
        );
      }
    };
    append(pinnedRead.items, { pinned: true, archived: false });
    append(timelineRead.items, { pinned: false, archived: false });
    append(archivedRead.items, { pinned: false, archived: true });
    try {
      bridge.syncWebRemoteControlTasks([...merged.values()]);
    } catch (error) {
      logger.warn(
        `${LOG_SCOPE} 同步任务快照失败`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [
    archivedRead.items,
    enabled,
    pinnedRead.items,
    timelineRead.items,
    workspaceTabs,
    workspaceTabsKey,
  ]);

  return null;
}

export const WebRemoteControlTrigger = memo(function WebRemoteControlTrigger({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  initialTaskId,
  compact = false,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  compact?: boolean;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const status = useWebRemoteControlStatus();
  const [open, setOpen] = useState(false);
  const presentation = useMemo(
    () => resolveTriggerStatusPresentation(status, intl.formatMessage),
    [intl.formatMessage, status],
  );
  const triggerLabel = intl.formatMessage({ id: "webRemoteControl.trigger" });
  const handleOpen = useCallback(() => {
    // 去遥测（P3）：官方此处上报 web-remote-control-entry，FreeCodeZ 只保留本地日志。
    logger.info(`${LOG_SCOPE} 打开 Web 远程控制弹层`, {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
      remoteSessionId: remoteSessionId ?? "none",
      initialTaskId: initialTaskId ?? "none",
    });
    setOpen(true);
  }, [initialTaskId, remoteSessionId, workspaceIdentity, workspacePath]);

  return (
    <>
      {/* 快照同步改由 RootWorkspaceContent 常驻挂载：触发按钮缺 workspacePath 时
          （如纯设置页）不渲染，若同步挂在这里会暂停，手机 bootstrap 会拿到空窗口集合。 */}
      <ControlHintTooltip
        title={triggerLabel}
        description={presentation.tooltip}
        side="top"
        align="center"
        triggerClassName={compact ? undefined : "w-full"}
      >
        <Button
          type="button"
          variant="ghost"
          size={compact ? "icon-lg" : "lg"}
          aria-label={triggerLabel}
          className={cn(
            compact
              ? "text-foreground hover:bg-surface-hover hover:text-foreground"
              : "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
            className,
          )}
          onClick={handleOpen}
        >
          <Smartphone className={cn("size-4", presentation.iconClassName)} />
          {compact ? <span className="sr-only">{triggerLabel}</span> : triggerLabel}
        </Button>
      </ControlHintTooltip>
      <WebRemoteControlDialog
        open={open}
        onOpenChange={setOpen}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        remoteSessionId={remoteSessionId}
        initialTaskId={initialTaskId}
      />
    </>
  );
});
