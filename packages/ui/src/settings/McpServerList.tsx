import {
  TID_MCP_OPEN_AUTHORIZATION_BUTTON,
  TID_MCP_SERVER_ROW,
  testId,
  type McpServerStatus,
  type ZCodeMcpServer,
  type ZCodeMcpServerStatusSnapshot,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { settingsResourceRowInteraction } from "@/settings/settingsResourceRowInteraction.js";
import { SettingsScopeBadge } from "@/settings/SettingsScopeBadge.js";
import {
  McpFailurePresentation,
  resolveMcpFailureMessageId,
} from "@/settings/McpFailurePresentation.js";
import { SettingsResourceList } from "@/settings/SettingsResourceGroup.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { CircleIcon, Cable, Loader2Icon, ExternalLink, Plus, Wrench } from "lucide-react";

export function McpStatusDot({
  status,
  attention = false,
  disabled = false,
  reason,
}: {
  status?: McpServerStatus;
  attention?: boolean;
  disabled?: boolean;
  reason: string;
}) {
  const color = disabled
    ? "text-foreground-subtlest"
    : status === "connected"
      ? "text-green-500"
      : status === "connecting"
        ? "text-yellow-500"
        : status === "error"
          ? "text-red-500"
          : attention
            ? "text-yellow-500"
            : "text-foreground-subtlest";

  const icon =
    !disabled && status === "connecting" ? (
      <Loader2Icon className={`size-3 shrink-0 animate-spin ${color}`} aria-hidden="true" />
    ) : (
      <CircleIcon className={`size-2.5 shrink-0 fill-current ${color}`} aria-hidden="true" />
    );

  return (
    <ControlHintTooltip title={reason} className="max-w-64">
      <span className="inline-flex cursor-help items-center">{icon}</span>
    </ControlHintTooltip>
  );
}

function ScopeBadge({ scope }: { scope?: string }) {
  const normalizedScope = scope === "workspace" ? "workspace" : "user";
  return <SettingsScopeBadge scope={normalizedScope} includeMcpTestAttribute />;
}

function McpServerItem({
  server,
  snapshot,
  onEdit,
  onToggle,
  onOpenAuthorization,
  onOpenTools,
  hideMetadata,
}: {
  server: ZCodeMcpServer;
  snapshot?: ZCodeMcpServerStatusSnapshot;
  onEdit: (server: ZCodeMcpServer) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onOpenAuthorization?: (server: ZCodeMcpServer) => void;
  /** 工具观测清单入口；仅 connected 且有 tools 明细的 server 传入。 */
  onOpenTools?: (server: ZCodeMcpServer) => void;
  hideMetadata: boolean;
}) {
  const { intl } = useZCodeIntl();
  const typeLabel = server.config.command
    ? "stdio"
    : (server.config.type ?? (server.config.url ? "http" : "?"));
  const canEdit = !server.location || server.location.source === "zcode";
  const canOpenAuthorization = Boolean(server.authorization?.authorizationUrl);
  const openAuthorizationLabel = intl.formatMessage({
    id: "settings.mcp.oauth.openAuthorization",
  });
  const statusReason = intl.formatMessage({
    id:
      server.status === "error"
        ? resolveMcpFailureMessageId(server.failureKind)
        : server.status === "connected"
          ? "settings.mcp.status.connectedReason"
          : server.status === "connecting"
            ? "settings.mcp.status.connectingReason"
            : server.status === "disconnected"
              ? "settings.mcp.status.disconnectedReason"
              : "settings.mcp.status.unknownReason",
  });

  const description = server.config.url
    ? `${typeLabel} · ${server.config.url}`
    : server.config.command
      ? `${typeLabel} · ${server.config.command} ${(server.config.args ?? []).join(" ")}`
      : typeLabel;
  // 工具观测明细存在（connected + connect 模式刷新）才提供清单入口；
  // tokens 徽章与 N/M 计数都来自 snapshot，缺失时回落到既有 toolCount 单计数展示。
  const snapshotTools = snapshot?.tools;
  const canOpenTools =
    Boolean(onOpenTools) && server.status === "connected" && (snapshotTools?.length ?? 0) > 0;

  return (
    <div
      className={`grid cursor-default grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors ${canEdit ? "hover:bg-hover" : ""}`}
      {...settingsResourceRowInteraction(canEdit ? () => onEdit(server) : undefined)}
      data-mcp-status={server.status ?? ""}
      data-mcp-tool-count={server.toolCount}
      data-testid={testId(TID_MCP_SERVER_ROW, server.name)}
    >
      <div
        className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-foreground-subtle"
        data-mcp-status-dot-placement="icon-corner"
      >
        <Cable className="size-4" aria-hidden="true" />
        <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-background">
          <McpStatusDot status={server.status} reason={statusReason} />
        </span>
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-ui-base font-medium text-foreground">{server.name}</span>
          {!hideMetadata ? <ScopeBadge scope={server.scope} /> : null}
          {!hideMetadata && typeof server.toolCount === "number" && (
            <span
              className="inline-flex rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border"
              title={resolveToolBadgeTitle(intl, snapshot)}
            >
              {resolveToolBadgeText(intl, server.toolCount, snapshot)}
            </span>
          )}
          {resolveToolBadgeTokens(snapshot) !== null && !hideMetadata ? (
            <span className="inline-flex rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtlest ring-1 ring-border">
              ~{resolveToolBadgeTokens(snapshot)} tk
            </span>
          ) : null}
        </div>
        <div className="mt-1 truncate text-ui-sm text-foreground-subtle">{description}</div>
        {server.status === "error" ? (
          <McpFailurePresentation error={server.error} failureKind={server.failureKind} />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canOpenTools && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={intl.formatMessage({ id: "settings.mcp.tools.open" })}
            title={intl.formatMessage({ id: "settings.mcp.tools.open" })}
            onClick={(event) => {
              event.stopPropagation();
              onOpenTools?.(server);
            }}
          >
            <Wrench className="size-4" aria-hidden="true" />
          </Button>
        )}
        {canOpenAuthorization && (
          <Button
            variant="link"
            size="sm"
            className="text-sky-500 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300"
            aria-label={openAuthorizationLabel}
            data-testid={testId(TID_MCP_OPEN_AUTHORIZATION_BUTTON, server.name)}
            title={openAuthorizationLabel}
            onClick={() =>
              runUserAction({
                input: { featureId: "extension.mcp", action: "authorize", trigger: "button" },
                operation: () => onOpenAuthorization?.(server),
                completed: { resultSource: "platform_result" },
                failureStage: "mcp_authorize",
              })
            }
          >
            <ExternalLink className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">{openAuthorizationLabel}</span>
          </Button>
        )}
        <Switch checked={server.enabled} onCheckedChange={(v) => onToggle(server.id, v)} />
      </div>
    </div>
  );
}

export function McpServerList({
  servers,
  snapshotByName,
  onCreate,
  onEdit,
  onToggle,
  onOpenAuthorization,
  onOpenTools,
  emptyTitle,
  emptyDescription,
  hideMetadata = false,
}: {
  servers: ZCodeMcpServer[];
  snapshotByName?: Record<string, ZCodeMcpServerStatusSnapshot>;
  onCreate: () => void;
  onEdit: (server: ZCodeMcpServer) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onOpenAuthorization?: (server: ZCodeMcpServer) => void;
  onOpenTools?: (server: ZCodeMcpServer) => void;
  emptyTitle: string;
  emptyDescription: string;
  hideMetadata?: boolean;
}) {
  const { intl } = useZCodeIntl();

  if (servers.length === 0) {
    return (
      <div className="overflow-hidden rounded-xl border border-dashed border-border">
        <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
          <div className="space-y-1">
            <div className="text-ui-base font-medium text-foreground">{emptyTitle}</div>
            <div className="text-ui-base text-foreground-subtle">{emptyDescription}</div>
          </div>
          <Button variant="outline" size="sm" onClick={onCreate}>
            <Plus className="size-4" />
            <span>{intl.formatMessage({ id: "settings.mcp.create.open" })}</span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SettingsResourceList
      items={servers}
      getKey={(server) => server.id}
      renderItem={(server) => (
        <McpServerItem
          server={server}
          snapshot={snapshotByName?.[server.name]}
          onEdit={onEdit}
          onToggle={onToggle}
          onOpenAuthorization={onOpenAuthorization}
          onOpenTools={onOpenTools}
          hideMetadata={hideMetadata}
        />
      )}
    />
  );
}

/** 工具计数徽章文案：有过滤时显示「N/M」，否则维持单计数（旧 CLI 兼容回落）。 */
function resolveToolBadgeText(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  toolCount: number,
  snapshot?: ZCodeMcpServerStatusSnapshot,
): string {
  if (
    snapshot?.visibleToolCount !== undefined &&
    snapshot.visibleToolCount !== snapshot.toolCount
  ) {
    return intl.formatMessage(
      { id: "settings.mcp.status.toolCountFiltered" },
      { visible: String(snapshot.visibleToolCount), count: String(snapshot.toolCount) },
    );
  }
  return intl.formatMessage({ id: "settings.mcp.status.toolCount" }, { count: String(toolCount) });
}

function resolveToolBadgeTitle(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  snapshot?: ZCodeMcpServerStatusSnapshot,
): string | undefined {
  if (
    snapshot?.visibleToolCount === undefined ||
    snapshot.visibleToolCount === snapshot.toolCount
  ) {
    return undefined;
  }
  return intl.formatMessage(
    { id: "settings.mcp.status.toolCountFilteredReason" },
    { count: String(snapshot.toolCount - snapshot.visibleToolCount) },
  );
}

/** 工具 tokens 徽章值：tools 明细缺席（status 轮询/旧 CLI）时返回 null 不展示。 */
function resolveToolBadgeTokens(snapshot?: ZCodeMcpServerStatusSnapshot): number | null {
  if (!snapshot?.tools || snapshot.tools.length === 0) return null;
  return snapshot.tools.reduce((total, tool) => total + tool.estimatedTokens, 0);
}
