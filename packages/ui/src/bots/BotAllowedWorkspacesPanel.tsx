/**
 * 工作区访问范围（附录C §1.5 `tin`）：全部 / 指定 + 复选列表。
 * 勾选走乐观保存 + 失败回滚（附录C §1.3 `Se`）。
 */
import { Check, LoaderCircle } from "lucide-react";
import type { BotConfig } from "@zcode/shared/bots";
import { isAllWorkspacesAllowed } from "@zcode/shared/bots";
import { cn } from "@/components/lib/utils.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BotPanelRow } from "@/bots/BotHeader.js";
import type { BotWorkspaceRef } from "@/bots/botsApi.js";

export function BotAllowedWorkspacesPanel({
  bot,
  workspaceRefs,
  currentWorkspace,
  loading,
  onPatchAllowedWorkspaces,
  onToggleWorkspaceAccess,
}: {
  bot: BotConfig;
  workspaceRefs: BotWorkspaceRef[];
  currentWorkspace: BotWorkspaceRef;
  loading: boolean;
  onPatchAllowedWorkspaces: (allowedWorkspaces: string[]) => void;
  onToggleWorkspaceAccess: (workspaceId: string, checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const all = isAllWorkspacesAllowed(bot.allowedWorkspaces);
  const selectedCount = all
    ? workspaceRefs.length
    : bot.allowedWorkspaces.filter((id) => workspaceRefs.some((ref) => ref.id === id)).length;
  return (
    <BotPanelRow
      label={intl.formatMessage({ id: "bots.allowedWorkspaces" })}
      description={
        all
          ? intl.formatMessage({ id: "bots.allowedWorkspaces.allDescription" })
          : intl.formatMessage(
              { id: "bots.allowedWorkspaces.selectedDescription" },
              { count: String(selectedCount) },
            )
      }
      control={
        <div className="flex items-center justify-end gap-2">
          {loading ? <LoaderCircle className="size-4 animate-spin text-foreground-subtle" /> : null}
          <Select
            value={all ? "all" : "selected"}
            onValueChange={(value) =>
              onPatchAllowedWorkspaces(value === "all" ? ["*"] : [currentWorkspace.id])
            }
            disabled={loading}
          >
            <SelectTrigger size="lg" className="w-48 justify-between">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {intl.formatMessage({ id: "bots.allowedWorkspaces.mode.all" })}
              </SelectItem>
              <SelectItem value="selected">
                {intl.formatMessage({ id: "bots.allowedWorkspaces.mode.selected" })}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      }
      detail={
        all ? null : (
          <div className="rounded-lg bg-background p-1">
            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {workspaceRefs.map((ref) => {
                const checked = bot.allowedWorkspaces.includes(ref.id);
                return (
                  <button
                    key={ref.id}
                    type="button"
                    className="flex min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => void onToggleWorkspaceAccess(ref.id, !checked)}
                    disabled={loading}
                    title={ref.label}
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center">
                      <div
                        className={cn(
                          "flex size-4 items-center justify-center rounded-sm border",
                          checked
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-input-border bg-input text-transparent",
                        )}
                      >
                        <Check className="size-3.5" />
                      </div>
                    </span>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="truncate text-ui-base font-medium text-foreground">
                        {ref.label}
                      </div>
                      <div className="truncate font-mono text-ui-base text-foreground-subtlest">
                        {ref.workspacePath}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )
      }
    />
  );
}
