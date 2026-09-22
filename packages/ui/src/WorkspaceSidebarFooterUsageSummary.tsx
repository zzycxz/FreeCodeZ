import { BarChart3Icon } from "lucide-react";
import { TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON } from "@zcode/shared";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsUsageIntent } from "@/lib/settingsNavigation.js";

/**
 * 用量入口菜单项。套餐徽标/升级入口/entitlement 探测已随 P2 §4.6「侧栏底栏改造」删除；
 * 用量摘要数据源改 key 直连属「用量面板两层设计」批次，这里只保留"使用统计"图表入口。
 */
export function WorkspaceSidebarFooterUsageSummaryContent({
  onUsageClick,
}: {
  onUsageClick?: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        data-testid={TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON}
        onSelect={() => {
          setPendingSettingsUsageIntent();
          onUsageClick?.();
        }}
      >
        <BarChart3Icon className="size-4" />
        {intl.formatMessage({ id: "sidebar.usage.plan.openStats" })}
      </DropdownMenuItem>
    </>
  );
}
