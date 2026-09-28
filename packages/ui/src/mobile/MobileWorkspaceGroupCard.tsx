import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, Cloud, FolderOpen, Loader, MessageCirclePlus, Plus, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import {
  isWorkspaceDisconnected,
  workspaceGroupIcon,
  type MobileWorkspaceTaskGroup,
} from "./mobileTaskGroups.js";

// 手机端工作区分组卡（附录C §7.4）：展开按钮+图标（conversation→message-circle-plus；
// remote→cloud；else folder-open）+label+kind 徽标（workspaceKind.*）+断连徽标+mono path+
// lastConnectionError 红字+updatedAt{time}+折叠时未读蓝点+taskCount{count}+chevron；
// 组按钮：断连→重新连接（连接中 spinner）；否则新建任务（startDraft）。

const GROUP_ICONS = {
  "message-circle-plus": MessageCirclePlus,
  cloud: Cloud,
  "folder-open": FolderOpen,
} as const;

const KIND_LABEL_IDS: Record<string, string> = {
  local: "webRemoteControl.mobileHome.workspaceKind.local",
  conversation: "webRemoteControl.mobileHome.workspaceKind.conversation",
  remote: "webRemoteControl.mobileHome.workspaceKind.remote",
};

export function MobileWorkspaceGroupCard({
  group,
  expanded,
  reconnecting,
  latestUpdatedAt,
  onToggleExpanded,
  onStartDraft,
  onReconnect,
  children,
}: {
  group: MobileWorkspaceTaskGroup;
  expanded: boolean;
  reconnecting: boolean;
  latestUpdatedAt: number | null;
  onToggleExpanded: () => void;
  onStartDraft: (workspaceKey: string) => void;
  onReconnect: (workspaceKey: string) => void;
  children?: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const { formatMessage } = intl;
  const { workspace, workspaceKey } = group;
  const disconnected = isWorkspaceDisconnected(workspace);
  const GroupIcon = GROUP_ICONS[workspaceGroupIcon(workspace)];
  const kindLabelId =
    workspace.workspacePurpose === "conversation"
      ? KIND_LABEL_IDS["conversation"]
      : workspace.kind === "remote"
        ? KIND_LABEL_IDS["remote"]
        : KIND_LABEL_IDS["local"];

  return (
    <section className="overflow-hidden rounded-xl border border-card-border bg-card">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
          onClick={onToggleExpanded}
        >
          <GroupIcon className="size-4 shrink-0 text-foreground-subtle" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-ui-base font-medium text-foreground">{workspace.label}</span>
              <span className="shrink-0 rounded-sm border border-border px-1 text-ui-xs text-foreground-subtle">
                {formatMessage({ id: kindLabelId ?? "webRemoteControl.mobileHome.workspaceKind.local" })}
              </span>
              {disconnected ? (
                <span className="shrink-0 rounded-sm border border-warning px-1 text-ui-xs text-warning">
                  {formatMessage({ id: "webRemoteControl.mobileHome.disconnected" })}
                </span>
              ) : null}
              {!expanded && group.hasUnread ? (
                <span className="size-2 shrink-0 rounded-full bg-brand" aria-hidden="true" />
              ) : null}
            </span>
            <span className="truncate font-mono text-ui-xs text-foreground-subtlest">
              {workspace.workspaceIdentity?.trim() || workspace.workspacePath}
            </span>
            {workspace.lastConnectionError ? (
              <span className="truncate text-ui-xs text-destructive">{workspace.lastConnectionError}</span>
            ) : null}
            <span className="flex items-center gap-1 text-ui-xs text-foreground-subtlest">
              {latestUpdatedAt !== null ? (
                <span>
                  {formatMessage(
                    { id: "webRemoteControl.mobileHome.updatedAt" },
                    { time: formatTaskRelativeTime(latestUpdatedAt, intl) },
                  )}
                </span>
              ) : null}
              <span>
                {formatMessage(
                  { id: "webRemoteControl.mobileHome.taskCount" },
                  { count: group.tasks.length },
                )}
              </span>
            </span>
          </span>
          {expanded ? (
            <ChevronDown className="size-4 shrink-0 text-foreground-subtle" />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-foreground-subtle" />
          )}
        </button>
        {disconnected ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={reconnecting}
            onClick={() => onReconnect(workspaceKey)}
          >
            {reconnecting ? <Loader className="size-3 animate-spin" /> : <Unplug className="size-3" />}
            {formatMessage({
              id: reconnecting
                ? "webRemoteControl.mobileHome.reconnecting"
                : "webRemoteControl.mobileHome.reconnect",
            })}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={formatMessage({ id: "taskList.newTask" })}
            title={formatMessage({ id: "taskList.newTask" })}
            onClick={() => onStartDraft(workspaceKey)}
          >
            <Plus className="size-3.5" />
          </Button>
        )}
      </div>
      {expanded ? (
        <div className={cn("flex flex-col gap-2 border-t border-border bg-background-alt p-2")}>
          {group.tasks.length === 0 ? (
            <p className="px-1 py-2 text-ui-sm text-foreground-subtlest">
              {formatMessage({ id: "webRemoteControl.mobileHome.workspaceEmpty" })}
            </p>
          ) : (
            children
          )}
        </div>
      ) : null}
    </section>
  );
}
