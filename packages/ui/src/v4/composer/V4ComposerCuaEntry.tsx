// FreeCodeZ W-19/W-30 复位件（M.1"改造换输入源"）：电脑操作输入框常驻入口。
// 旧版数据编排（插件启停轮询/权限状态机/会话 busy 三路汇聚）已随旧栈拆除；新面简版：
// 设置键门控（cuaControlEnabled 总闸 + computerUseComposerEntryHidden 入口开关）+
// 桌面本地判定；点击打开电脑控制设置区（权限引导/状态面所在地）。
import { memo } from "react";
import { MonitorCogIcon } from "lucide-react";
import { TID_V4_COMPOSER_CUA_ENTRY } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveComputerUseAvailability } from "@/lib/computerUseAvailability.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";

interface V4ComposerCuaEntryProps {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  currentSessionBusy?: boolean;
}

function isRemoteWorkspace(workspaceIdentity?: string): boolean {
  return Boolean(workspaceIdentity && workspaceIdentity.includes("://"));
}

export const V4ComposerCuaEntry = memo(function V4ComposerCuaEntry(
  props: V4ComposerCuaEntryProps,
) {
  const platform = usePlatform();
  const { settings } = useSettings();
  const { intl } = useZCodeIntl();

  if (props.remoteSessionId || isRemoteWorkspace(props.workspaceIdentity)) return null;
  // 桌面判定：W-19 平台面的 Desktop-only 方法在场即桌面（D2 三平台全支持，无 OS 细分门）。
  const isDesktop = typeof platform.openComputerUsePermissionGuide === "function";
  const availability = resolveComputerUseAvailability({ isDesktop });
  if (!availability.supported) return null;
  if (settings?.cuaControlEnabled !== true) return null;
  if (settings?.computerUseComposerEntryHidden === true) return null;

  return (
    <ControlHintTooltip
      title={intl.formatMessage({ id: "chat.toolbar.computerUse.label" })}
      description={intl.formatMessage({ id: "chat.toolbar.computerUse.tooltip.ready" })}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid={TID_V4_COMPOSER_CUA_ENTRY}
        aria-label={intl.formatMessage({ id: "chat.toolbar.computerUse.label" })}
        onClick={() => {
          // 打开电脑控制设置区：权限引导/状态面/动作门所在地。
          setPendingSettingsSectionIntent("computerUse");
        }}
      >
        <MonitorCogIcon className="size-4" />
      </Button>
    </ControlHintTooltip>
  );
});
