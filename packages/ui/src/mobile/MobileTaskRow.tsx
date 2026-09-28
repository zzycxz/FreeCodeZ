import { Circle, CircleAlert, CircleCheck, Loader, Pin } from "lucide-react";
import { TaskWorkflowRunLines } from "@/components/workflow-run-line/TaskWorkflowRunLines.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import type { SessionWorkflowActivity } from "@zcode/shared/zcode-protocol-v4";
import type { RemoteTaskListItem } from "@zcode/shared/web-remote-control";
import { isTaskUnread, taskStatusPill } from "./mobileTaskGroups.js";
import type { MobileSortBy } from "./mobilePreferences.js";

// 手机端任务行（附录C §7.4）：pin 图标 + 未读蓝点 + 标题（空→taskList.untitled）+
// 副行（workspaceLabel · 相对时间 Tx(sortBy)）+ WorkflowRunLines(compact) + 状态 pill 四态。
// 整行是「打开任务」按钮（aria-label=webRemoteControl.openTask{title}）。

const STATUS_ICONS = {
  loader: Loader,
  "circle-check": CircleCheck,
  "circle-alert": CircleAlert,
  circle: Circle,
} as const;

export function MobileTaskRow({
  task,
  sortBy,
  onOpen,
  className,
}: {
  task: RemoteTaskListItem;
  sortBy: MobileSortBy;
  onOpen: (task: RemoteTaskListItem) => void;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const { formatMessage } = intl;
  // 官方 p5t 行内绑定（styles@3969800 邻域）：`c=e.displayStatus??\`idle\``——displayStatus
  // 是 T2 层 J8t（mergeTaskDisplayStatus）的归并结果，行内不再二次归并。
  const displayStatus = task.displayStatus ?? "idle";
  const pill = taskStatusPill(displayStatus);
  const StatusIcon = STATUS_ICONS[pill.icon];
  const title = task.title.trim() || formatMessage({ id: "taskList.untitled" });
  const timestamp = sortBy === "created" ? task.createdAt : task.updatedAt;
  const unread = isTaskUnread(task);
  const workflowActivity = task.workflowActivity as SessionWorkflowActivity | undefined;

  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-start gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-surface-hover",
        className,
      )}
      aria-label={formatMessage({ id: "webRemoteControl.openTask" }, { title })}
      onClick={() => onOpen(task)}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-1.5">
          {task.pinned === true ? (
            <Pin className="size-3.5 shrink-0 text-foreground-subtle" aria-label={formatMessage({ id: "taskList.pin" })} />
          ) : null}
          {unread ? (
            <span className="size-2 shrink-0 rounded-full bg-brand" aria-hidden="true" />
          ) : null}
          <span className="truncate text-ui-base font-medium text-foreground">{title}</span>
        </span>
        <span className="truncate text-ui-sm text-foreground-subtle">
          {task.workspaceLabel} · {formatTaskRelativeTime(timestamp, intl)}
        </span>
        {workflowActivity ? (
          <TaskWorkflowRunLines
            activity={workflowActivity}
            isActive={false}
            intl={intl}
            density="compact"
          />
        ) : null}
      </span>
      <span
        className={cn(
          "mt-0.5 flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-ui-xs",
          pill.toneClassName,
        )}
      >
        <StatusIcon className={cn("size-3", pill.status === "running" && "animate-spin")} />
        {formatMessage({ id: `webRemoteControl.taskStatus.${pill.status}` })}
      </span>
    </button>
  );
}
