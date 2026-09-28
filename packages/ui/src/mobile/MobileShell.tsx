import { useEffect } from "react";
import { ArrowLeft, Loader } from "lucide-react";
import type { IPlatformService } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MobileChatView } from "./MobileChatView.js";
import { MobileSidePaneDrawer } from "./MobileSidePaneDrawer.js";
import { MobileTaskHome } from "./MobileTaskHome.js";
import { MobileThemeMenu } from "./MobileThemeMenu.js";
import type { MobileNavigationIntent } from "./mobileNavigation.js";
import type {
  MobileBridgeConnection,
  MobileRemoteSession,
  MobileSidePaneContent,
} from "./mobileRemoteTypes.js";
import { resolveFailureMessageId, useMobileShellController } from "./useMobileShellController.js";
import type { StorageLike } from "./mobilePreferences.js";

// 手机端外壳（附录C §7.1–§7.4）：home|chat 伪路由视图切换 + 顶栏（返回 arrow-left +
// mobileShell.chatTitle + 主题菜单）+ 右抽屉 data-mobile-side-pane-overlay + 跨 workspace 切换遮罩 +
// 断线横幅 data-web-remote-control-reconnect-notice（直接接 relay 传输状态，spec W2）+
// failure.* 失败横幅（kicked 分流）。

export interface MobileShellProps {
  session: MobileRemoteSession;
  platform: IPlatformService;
  initialNavigationIntent?: MobileNavigationIntent | null;
  storage?: StorageLike;
  sidePaneContent?: MobileSidePaneContent | null;
  /** 桥生命周期回调：宿主据此把服务面交给 ZCodeIntlProvider（语言以桌面 settings 为准）。 */
  onBridgeChange?: (connection: MobileBridgeConnection | null) => void;
}

export function MobileShell({
  session,
  platform,
  initialNavigationIntent,
  storage,
  sidePaneContent,
  onBridgeChange,
}: MobileShellProps) {
  const { intl } = useZCodeIntl();
  const { formatMessage } = intl;
  const controller = useMobileShellController({
    session,
    navigationIntent: initialNavigationIntent ?? null,
    ...(storage ? { storage } : {}),
  });
  const bridge = controller.active?.bridge ?? null;
  useEffect(() => {
    onBridgeChange?.(bridge);
  }, [bridge, onBridgeChange]);
  const showReconnectNotice =
    controller.link.phase === "reconnecting" || controller.link.phase === "waiting-pair";
  const inChat = controller.page === "chat" && controller.active !== null;

  return (
    <div className="relative flex h-dvh min-h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
      {showReconnectNotice ? (
        <div
          data-web-remote-control-reconnect-notice="true"
          className="flex items-center gap-2 border-b border-warning bg-card px-4 py-2 text-ui-sm text-warning"
        >
          <Loader className="size-3.5 animate-spin" />
          {formatMessage({ id: "webRemoteControl.mobileShell.reconnecting" })}
        </div>
      ) : null}

      {controller.failure ? (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-destructive bg-card px-4 py-2 text-ui-sm text-destructive"
        >
          <p className="min-w-0 flex-1">
            {formatMessage({ id: resolveFailureMessageId(controller.failure) })}
          </p>
          <Button type="button" variant="ghost" size="xs" onClick={controller.clearFailure}>
            {formatMessage({ id: "common.confirm" })}
          </Button>
        </div>
      ) : null}

      {inChat && controller.active ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={formatMessage({ id: "webRemoteControl.mobileShell.backHome" })}
              title={formatMessage({ id: "webRemoteControl.mobileShell.backHome" })}
              onClick={controller.navigateBack}
            >
              <ArrowLeft className="size-4" />
            </Button>
            <span className="min-w-0 flex-1 truncate text-ui-base font-medium">
              {formatMessage({ id: "webRemoteControl.mobileShell.chatTitle" })}
            </span>
            <MobileThemeMenu />
          </div>
          <MobileChatView
            key={`${controller.active.workspaceKey}:${controller.active.taskId ?? "draft"}:${controller.chatRefreshKey}`}
            bridge={controller.active.bridge}
            workspace={controller.active.workspace}
            task={controller.activeTask}
            platform={platform}
            sidePaneOpen={controller.sidePaneOpen}
            onToggleSidePane={() => controller.setSidePaneOpen(!controller.sidePaneOpen)}
            onSessionCreated={controller.onSessionCreated}
            onSessionDeleted={controller.onSessionDeleted}
          />
          <MobileSidePaneDrawer
            open={controller.sidePaneOpen}
            content={sidePaneContent ?? controller.sidePaneContent}
            onClose={() => controller.setSidePaneOpen(false)}
          />
        </div>
      ) : (
        <MobileTaskHome
          workspaces={controller.workspaces}
          tasks={controller.tasks}
          loading={controller.loading}
          errorText={controller.errorText}
          connected={controller.link.phase === "paired" && controller.link.pairStatus === "matched"}
          preferences={controller.preferences}
          onPreferencesChange={controller.setPreferences}
          onOpenTask={controller.openTask}
          onStartDraft={controller.startDraft}
          onReconnectWorkspace={controller.reconnectWorkspace}
          reconnectingWorkspaceKey={controller.reconnectingWorkspaceKey}
          activeWorkspaceKey={controller.activeWorkspaceKey}
          onRefresh={controller.refresh}
          navigationCollapsed={controller.navigationCollapsed}
          onToggleNavigationCollapsed={controller.toggleNavigationCollapsed}
        />
      )}

      {controller.switching ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center gap-2 bg-black/60 text-ui-sm text-foreground-inverse"
          role="status"
        >
          <Spinner className="size-5" />
          {formatMessage({ id: "common.loading" })}
        </div>
      ) : null}
    </div>
  );
}
