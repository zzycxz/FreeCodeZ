import { useMemo } from "react";
import { MCP_TOOL_SCHEMA_LARGE_BYTES, type ZCodeMcpToolSummary } from "@zcode/shared";
import { Switch } from "@/components/ui/switch.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

/**
 * 单 server 工具观测清单（spec mcp-availability-first-cost-management 规则 2.3）：
 * 逐工具展示成本估算与不可见归因（用户关闭 / 服务端声明），并允许切换
 * disabledTools（denylist：关=剔除出模型装配，开=默认放行）。
 * 数据来自协议 snapshot 的 tools 明细（connect 模式填充）；开关经
 * McpSettingsSection 走既有 updateMcpServer 落盘路径，不新增写路径。
 */
export function McpServerToolsDialog({
  serverName,
  tools,
  disabledTools,
  readOnly = false,
  open,
  onOpenChange,
  onDisabledToolsChange,
}: {
  serverName: string;
  tools: ZCodeMcpToolSummary[];
  disabledTools: readonly string[];
  readOnly?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisabledToolsChange?: (next: string[]) => void;
}) {
  const { intl } = useZCodeIntl();
  const disabledSet = useMemo(() => new Set(disabledTools), [disabledTools]);
  const totalTokens = useMemo(
    () => tools.reduce((total, tool) => total + tool.estimatedTokens, 0),
    [tools],
  );

  const toggleTool = (toolName: string, enabled: boolean) => {
    if (readOnly || !onDisabledToolsChange) return;
    const current = new Set(disabledSet);
    if (enabled) {
      current.delete(toolName);
    } else {
      current.add(toolName);
    }
    onDisabledToolsChange([...current]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(560px,calc(100dvh-2rem))] max-h-[min(560px,calc(100dvh-2rem))] max-w-xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "settings.mcp.tools.title" }, { name: serverName })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage(
              { id: "settings.mcp.tools.summary" },
              {
                count: String(tools.length),
                tokens: String(totalTokens),
              },
            )}
            {readOnly
              ? ` ${intl.formatMessage({ id: "settings.mcp.tools.readOnly" })}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tools.length === 0 ? (
            <p className="px-1 py-6 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.mcp.tools.empty" })}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {tools.map((tool) => (
                <li
                  key={tool.toolName}
                  data-testid={`mcp-tool-row-${tool.toolName}`}
                  className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover"
                >
                  <Switch
                    checked={!disabledSet.has(tool.toolName)}
                    disabled={readOnly || !tool.modelVisible}
                    onCheckedChange={(value) => {
                      if (!tool.modelVisible) {
                        logger.debug("[mcp-tools] 服务端声明仅界面使用的工具无用户开关", {
                          serverName,
                          toolName: tool.toolName,
                        });
                        return;
                      }
                      toggleTool(tool.toolName, value);
                    }}
                    aria-label={tool.toolName}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-mono text-ui-sm text-foreground">
                        {tool.toolName}
                      </span>
                      {tool.schemaBytes > MCP_TOOL_SCHEMA_LARGE_BYTES ? (
                        <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-ui-sm text-warning">
                          {intl.formatMessage({ id: "settings.mcp.tools.schemaLarge" })}
                        </span>
                      ) : null}
                      {!tool.modelVisible ? (
                        <span className="rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border">
                          {intl.formatMessage({ id: "settings.mcp.tools.uiOnly" })}
                        </span>
                      ) : null}
                    </div>
                    {tool.description ? (
                      <p className="mt-0.5 line-clamp-2 text-ui-sm text-foreground-subtle">
                        {tool.description}
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-ui-sm text-foreground-subtlest">
                    ~{tool.estimatedTokens} tk
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
