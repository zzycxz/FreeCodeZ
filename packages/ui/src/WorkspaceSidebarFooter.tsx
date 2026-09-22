/* oxlint-disable eslint(max-lines) -- footer 聚合 Provider 状态条与平台能力共享菜单，
   SettingsPage 复用同一骨架，拆文件会打断菜单分组顺序与复用约束。 */
import type { Locale } from "@zcode/shared";
import { memo, useCallback, useEffect, useState } from "react";
import {
  DesktopCommandIds,
  TID_MANAGE_PROVIDERS_MENU_ITEM,
  TID_PROVIDER_STATUS_TRIGGER,
  TID_TASK_SETTINGS_BUTTON,
} from "@zcode/shared";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  CircleIcon,
  Globe,
  KeyRound,
  Maximize,
  Palette,
  PencilRuler,
  Settings,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useModelSelectionView } from "@/hooks/useModelSelectionView.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { parseCustomProviderIdFromSupplierKey } from "@/lib/modelConfigSync.js";
import { normalizeInterfaceMode } from "@/lib/interfaceMode.js";
import {
  resolveSidebarProviderKeyHealth,
  type SidebarProviderKeyHealth,
} from "@/lib/sidebarProviderStatus.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { ProviderLogo } from "@/settings/model-provider-section/ProviderLogo.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import type { Theme } from "@/useTheme.js";
import { WorkspaceSidebarFooterUsageSummaryContent } from "@/WorkspaceSidebarFooterUsageSummary.js";

const DESKTOP_ZOOM_MIN_LEVEL = -3;
const DESKTOP_ZOOM_MAX_LEVEL = 5;

// 三态展示映射（docs/spec/sidebar-provider-key-status.md）：语义色 + 可读文案，不以颜色单独表意。
const PROVIDER_KEY_HEALTH_PRESENTATION: Record<
  SidebarProviderKeyHealth,
  { labelId: string; color: string }
> = {
  "not-configured": { labelId: "sidebar.providerStatus.notConfigured", color: "text-warning" },
  ready: { labelId: "sidebar.providerStatus.ready", color: "text-success" },
  invalid: { labelId: "sidebar.providerStatus.invalid", color: "text-destructive" },
};

export const WorkspaceSidebarFooter = memo(function WorkspaceSidebarFooterComponent({
  theme,
  localeMenuValue,
  onLocaleChange,
  onThemeChange,
  onSettingsButtonClick,
  onUsageClick,
  settingsButtonMode = "settings",
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  isDesktop = false,
  className,
}: {
  theme: Theme;
  localeMenuValue: Locale | "system";
  onLocaleChange: (value: string) => void;
  onThemeChange: (value: string) => void;
  onSettingsButtonClick?: () => void;
  onUsageClick?: () => void;
  settingsButtonMode?: "settings" | "back";
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  isDesktop?: boolean;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const interfaceMode = useZCodeStore((state) => state.interfaceMode);
  const setInterfaceMode = useZCodeStore((state) => state.setInterfaceMode);
  const zoomInShortcutLabel = useShortcutCommandLabel("zoomIn");
  const zoomOutShortcutLabel = useShortcutCommandLabel("zoomOut");
  const resetZoomShortcutLabel = useShortcutCommandLabel("resetZoom");
  // Provider 事实来自 registry 快照；当前生效选择与模型选择器同源。
  // 只做展示映射：不读取/校验 key 字符串，不在 UI 二次请求猜状态。
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  const modelSelectionRead = useModelSelectionView(
    workspacePath,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  // 契约允许"页面展示不完整选择，执行入口才要求 effectiveSelection"（EffectiveModelSelectionResult 注释）。
  // 底栏是展示位：解析失败（selectionIssue）时必须回退 preferredSelection（已持久化的用户选择意图），
  // 否则模板供应商（原生 supplier key）+ 暂时解析失败时会误显示"连接使用"，掩盖真实接入状态。
  const resolvedSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const effectiveSelection =
    resolvedSelectionView?.effectiveSelection ??
    resolvedSelectionView?.preferredSelection ??
    null;
  const selectedSupplierKey = useZCodeSessionStore((state) =>
    workspacePath
      ? selectWorkspaceZCodeState(state, workspacePath, workspaceIdentity).selectedSupplierKey
      : "",
  );
  // 选择失效（selectionIssue/remote-waiting）时用 supplier key 兜底定位 provider，
  // 健康点仍按 registry 事实显示，模型文案降级为 provider 名。
  const currentProviderId =
    effectiveSelection?.providerId ?? parseCustomProviderIdFromSupplierKey(selectedSupplierKey);
  const provider =
    providerSettingsView?.providers.find(
      (candidate) => candidate.providerId === currentProviderId,
    ) ?? null;
  const keyHealth = resolveSidebarProviderKeyHealth(
    provider
      ? {
          enabled: provider.enabled,
          executable: provider.executable,
          hasPersonalConfig: Boolean(provider.personalConfig),
        }
      : null,
  );
  const modelIdLabel = effectiveSelection?.modelId ?? null;
  const providerNameLabel = provider?.providerName?.trim() || null;
  const statusBadge =
    modelIdLabel ?? providerNameLabel ?? intl.formatMessage({ id: "sidebar.profile.notLoggedIn" });
  const healthLabel = intl.formatMessage({
    id: PROVIDER_KEY_HEALTH_PRESENTATION[keyHealth].labelId,
  });
  const triggerTitle =
    providerNameLabel && modelIdLabel
      ? `${providerNameLabel} · ${modelIdLabel} · ${healthLabel}`
      : providerNameLabel
        ? `${providerNameLabel} · ${healthLabel}`
        : healthLabel;
  const profileContent = (
    <>
      <ProviderLogo logo={provider?.effectiveConfig.logo} className="size-5" />
      <div className="min-w-0 flex-1 overflow-hidden text-left">
        <div className="flex min-w-0 items-center gap-1.5">
          {/* model ID 用等宽（DESIGN.md：技术标识走 font-mono），provider 名回落常规字重。 */}
          <span
            className={cn(
              "min-w-0 truncate text-ui-base font-semibold text-foreground",
              modelIdLabel ? "font-mono" : null,
            )}
          >
            {statusBadge}
          </span>
          <CircleIcon
            data-provider-key-health={keyHealth}
            aria-label={healthLabel}
            className={cn(
              "size-2 shrink-0 fill-current",
              PROVIDER_KEY_HEALTH_PRESENTATION[keyHealth].color,
            )}
          />
        </div>
      </div>
    </>
  );
  const settingsButtonLabel =
    settingsButtonMode === "back"
      ? intl.formatMessage({ id: "workspace.backToWorkspace" })
      : intl.formatMessage({ id: "settings.title" });
  const usageButtonClick = onUsageClick ?? onSettingsButtonClick;
  const handleManageProviders = useCallback(() => {
    setPendingSettingsSectionIntent(
      "modelProvider",
      currentProviderId ? { modelProviderId: currentProviderId } : {},
    );
    // 设置页场景（settingsButtonMode="back"）经 section intent 就地切换分区，
    // 不能触发 onSettingsButtonClick（那是"返回工作区"）。
    if (settingsButtonMode !== "back") {
      onSettingsButtonClick?.();
    }
  }, [currentProviderId, onSettingsButtonClick, settingsButtonMode]);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [desktopZoomLevel, setDesktopZoomLevel] = useState(0);
  const runDesktopZoomCommand = useCallback(
    (command: (typeof DesktopCommandIds)["ZoomIn" | "ZoomOut" | "ResetZoom"]) => {
      void platform.executeDesktopCommand(command);
    },
    [platform],
  );

  useEffect(() => {
    if (!isDesktop) {
      setDesktopZoomLevel(0);
      return;
    }

    let isCancelled = false;
    void platform.getDesktopZoomLevel?.().then((state) => {
      if (!isCancelled && Number.isFinite(state.zoomLevel)) {
        setDesktopZoomLevel(state.zoomLevel);
      }
    });

    const dispose = platform.onDesktopZoomLevelChanged?.((state) => {
      if (Number.isFinite(state.zoomLevel)) {
        setDesktopZoomLevel(state.zoomLevel);
      }
    });

    return () => {
      isCancelled = true;
      dispose?.();
    };
  }, [isDesktop, platform]);

  const canResetDesktopZoom = desktopZoomLevel !== 0;
  const canZoomIn = desktopZoomLevel < DESKTOP_ZOOM_MAX_LEVEL;
  const canZoomOut = desktopZoomLevel > DESKTOP_ZOOM_MIN_LEVEL;

  return (
    // footer 被 Settings 复用，页面专属边距由调用方传入，避免修改共享默认样式。
    <footer className={cn("flex shrink-0 flex-col gap-2.5 px-4 pt-2 pb-4", className)}>
      <div className="flex min-w-0 gap-2">
        <DropdownMenu open={profileMenuOpen} onOpenChange={setProfileMenuOpen}>
          <DropdownMenuTrigger asChild>
            {/* 主体行是 Provider/Key 状态指示器（P2 §4.6），点击展开共享菜单；
              账号身份/登录按钮已删，"管理 Provider"承接原账号组的管理职能。 */}
            <Button
              type="button"
              variant="ghost"
              size={"lg"}
              className="min-w-0 flex-1 justify-start gap-2 overflow-hidden rounded-tl-2xl rounded-bl-2xl border-0 pl-0"
              data-testid={TID_PROVIDER_STATUS_TRIGGER}
              aria-label={triggerTitle}
              title={triggerTitle}
            >
              {/* Button 默认 shrink-0 且带 whitespace-nowrap，超长模型名会把 footer 撑出 sidebar。
                这里让触发按钮和文本列都允许收缩，并只在模型/名称自身做单行截断。 */}
              {profileContent}
            </Button>
          </DropdownMenuTrigger>
          {/* 菜单内容保持挂载，避免每次点击都重建 footer 内部状态。*/}
          <DropdownMenuContent align="start" className="w-max min-w-50" forceMount>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Globe className="size-4" />
                {intl.formatMessage({ id: "settings.locale" })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup value={localeMenuValue} onValueChange={onLocaleChange}>
                  <DropdownMenuRadioItem value="system">
                    {intl.formatMessage({
                      id: "sidebar.settings.systemDefault",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="en-US">
                    {intl.formatMessage({
                      id: "sidebar.settings.locale.en-US",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="zh-CN">
                    {intl.formatMessage({
                      id: "sidebar.settings.locale.zh-CN",
                    })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Palette className="size-4" />
                {intl.formatMessage({ id: "settings.themeMode" })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup value={theme} onValueChange={onThemeChange}>
                  <DropdownMenuRadioItem value="system">
                    {intl.formatMessage({
                      id: "sidebar.settings.systemDefault",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="zai-dark">
                    {intl.formatMessage({
                      id: "sidebar.settings.theme.zai-dark",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="zai-light">
                    {intl.formatMessage({
                      id: "sidebar.settings.theme.zai-light",
                    })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <PencilRuler className="size-4" />
                {intl.formatMessage({ id: "settings.interfaceMode" })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup
                  value={interfaceMode}
                  onValueChange={(value) => setInterfaceMode(normalizeInterfaceMode(value))}
                >
                  <DropdownMenuRadioItem value="coding">
                    {intl.formatMessage({ id: "settings.interfaceMode.coding" })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="office">
                    {intl.formatMessage({ id: "settings.interfaceMode.office" })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {/* 快捷键设置：缩放子菜单 label 读生效表，设置页改绑后即时跟随 */}
            {/* 收口重复缩放子菜单时误留了语言之后的那份，导致菜单顺序变成
                语言→缩放→主题；账户菜单分组顺序固定为 语言→主题→界面模式→缩放→用量→管理 Provider，
                这里把唯一一份（读生效表）挪回用量摘要之前，不要再补第二份缩放子菜单。 */}
            {isDesktop ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ZoomIn className="size-4" />
                  {intl.formatMessage({ id: "sidebar.settings.interfaceZoom" })}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-50">
                  <DropdownMenuItem
                    disabled={!canZoomIn}
                    onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ZoomIn)}
                  >
                    <ZoomIn className="size-4" />
                    {intl.formatMessage({ id: "titleBar.menu.view.zoomIn" })}
                    <DropdownMenuShortcut>{zoomInShortcutLabel}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canZoomOut}
                    onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ZoomOut)}
                  >
                    <ZoomOut className="size-4" />
                    {intl.formatMessage({ id: "titleBar.menu.view.zoomOut" })}
                    <DropdownMenuShortcut>{zoomOutShortcutLabel}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canResetDesktopZoom}
                    onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ResetZoom)}
                  >
                    <Maximize className="size-4" />
                    {intl.formatMessage({ id: "titleBar.menu.view.actualSize" })}
                    <DropdownMenuShortcut>{resetZoomShortcutLabel}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            {/* 用量入口（使用统计）保留；套餐徽标/升级入口已删。 */}
            <WorkspaceSidebarFooterUsageSummaryContent onUsageClick={usageButtonClick} />
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid={TID_MANAGE_PROVIDERS_MENU_ITEM}
              onSelect={handleManageProviders}
            >
              <KeyRound className="size-4" />
              {intl.formatMessage({ id: "sidebar.providerStatus.manage" })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex shrink-0 items-center gap-1.5">
          <ControlHintTooltip title={settingsButtonLabel}>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              data-testid={TID_TASK_SETTINGS_BUTTON}
              aria-label={settingsButtonLabel}
              disabled={!onSettingsButtonClick}
              onClick={onSettingsButtonClick}
            >
              <Settings className="size-4" />
            </Button>
          </ControlHintTooltip>
        </div>
      </div>
    </footer>
  );
});
