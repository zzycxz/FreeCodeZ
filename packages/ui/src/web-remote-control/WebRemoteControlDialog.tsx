/* eslint-disable max-lines -- 弹窗左卡连接态/失败横幅/配对链路是同一份状态机投影，拆文件会把一次操作的加载态切成多处真相。 */
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { WebRemoteControlContext } from "@zcode/shared/web-remote-control";
import { toDataURL } from "qrcode";
import {
  Bot,
  Copy,
  Globe,
  LoaderCircle,
  MonitorSmartphone,
  RefreshCw,
  Smartphone,
  Unplug,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";
import { BotsDialog } from "@/bots/BotsDialog.js";
import { BotChannelIcon } from "@/bots/BotChannelIcon.js";
import {
  getWebRemoteControlBridge,
  isMobileConnectedSession,
  isSameContextSession,
  publishWebRemoteControlStatus,
  useWebRemoteControlStatus,
  type WebRemoteControlPairNic,
  type WebRemoteControlStatusSnapshot,
} from "@/web-remote-control/useWebRemoteControlStatus.js";
import { resolveWebRemoteControlFailureMessage } from "@/web-remote-control/webRemoteControlFailure.js";

const LOG_SCOPE = "[WebRemoteControlDialog]";

/** 右卡 4 个 Bot Channel（附录C §1.2 `ain`）。 */
const BOT_CHANNEL_PROVIDERS: readonly {
  provider: "weixin" | "feishu" | "lark" | "telegram";
}[] = [
  { provider: "weixin" },
  { provider: "feishu" },
  { provider: "lark" },
  { provider: "telegram" },
];

/** 区域徽章（附录C §1.2 `Prn`）：Lark=全球、飞书=中国。 */
function resolveRegionTagKey(provider: string): string | null {
  switch (provider) {
    case "lark":
      return "login.oauth.regionTag.zai";
    case "feishu":
      return "login.oauth.regionTag.bigmodel";
    default:
      return null;
  }
}

function resolveStatusTitle(
  status: WebRemoteControlStatusSnapshot,
  formatMessage: IntlInstance["formatMessage"],
): string {
  switch (status.status) {
    case "starting":
      return formatMessage({ id: "webRemoteControl.status.starting" });
    case "running":
      return formatMessage({ id: "webRemoteControl.status.running" });
    case "connecting":
      return formatMessage({ id: "webRemoteControl.status.connecting" });
    case "active":
      return formatMessage({ id: "webRemoteControl.status.active" });
    case "error":
      return formatMessage({ id: "webRemoteControl.status.error" });
    default:
      return formatMessage({ id: "webRemoteControl.status.idle" });
  }
}

function resolveStatusDetail(
  status: WebRemoteControlStatusSnapshot,
  formatMessage: IntlInstance["formatMessage"],
): string {
  switch (status.status) {
    case "starting":
      return formatMessage({ id: "webRemoteControl.statusDetail.starting" });
    case "running":
      return formatMessage({ id: "webRemoteControl.statusDetail.running" });
    case "connecting":
      return formatMessage({ id: "webRemoteControl.statusDetail.connecting" });
    case "active":
      return formatMessage({ id: "webRemoteControl.statusDetail.active" });
    case "error":
      return formatMessage({ id: "webRemoteControl.statusDetail.error" });
    default:
      return formatMessage({ id: "webRemoteControl.statusDetail.idle" });
  }
}

/** 状态 tag：优先显示手机端浏览器平台/设备名，其次 手机 / 未开启 / 连接失败 / 已就绪。 */
function resolveStatusTag(
  status: WebRemoteControlStatusSnapshot,
  formatMessage: IntlInstance["formatMessage"],
): string {
  const browserPlatform = status.mobileDeviceInfo?.browserPlatform?.trim();
  if (browserPlatform) {
    return browserPlatform;
  }
  const deviceName = status.mobileDeviceInfo?.name?.trim();
  if (deviceName) {
    return deviceName;
  }
  if (status.mobileConnected) {
    return formatMessage({ id: "webRemoteControl.statusTag.phone" });
  }
  if (status.status === "idle") {
    return formatMessage({ id: "webRemoteControl.status.idle" });
  }
  if (status.status === "error") {
    return formatMessage({ id: "webRemoteControl.status.error" });
  }
  return formatMessage({ id: "webRemoteControl.statusTag.ready" });
}

function resolveStatusDotClassName(status: WebRemoteControlStatusSnapshot): string {
  if (status.status === "error") {
    return "bg-destructive";
  }
  if (status.status === "active") {
    return "bg-success";
  }
  if (status.status === "idle") {
    return "bg-border";
  }
  return "bg-warning";
}

/** 连接卡标题右侧的状态大字颜色（截图一：error 红 / active 绿 / idle 灰 / 其余 warning）。 */
function resolveStatusTitleClassName(status: WebRemoteControlStatusSnapshot): string {
  if (status.status === "error") {
    return "text-destructive";
  }
  if (status.status === "active") {
    return "text-success";
  }
  if (status.status === "idle") {
    return "text-foreground-subtle";
  }
  return "text-warning";
}

export const WebRemoteControlDialog = memo(function WebRemoteControlDialog({
  open,
  onOpenChange,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  initialTaskId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const status = useWebRemoteControlStatus();
  const [busy, setBusy] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [botsOpen, setBotsOpen] = useState(false);
  const [entryProvider, setEntryProvider] = useState<string | null>(null);
  const [pairNics, setPairNics] = useState<WebRemoteControlPairNic[] | null>(null);
  const [pinnedPairAddress, setPinnedPairAddress] = useState("");
  // 远程访问开放能力（spec §1.11）：null=preload 无此面或未加载；""=内嵌局域网模式。
  const [externalRelayUrl, setExternalRelayUrl] = useState<string | null>(null);
  const [externalRelayDraft, setExternalRelayDraft] = useState("");
  const [externalRelayBusy, setExternalRelayBusy] = useState(false);

  // 配对网卡候选 + 自建中继 origin（spec §5/§1.11）：preload 有此面才展示；加载一次即可。
  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    const bridge = getWebRemoteControlBridge();
    if (!bridge) {
      return;
    }
    if (bridge.listWebRemoteControlPairNics) {
      void bridge
        .listWebRemoteControlPairNics()
        .then((result) => {
          if (!cancelled) {
            setPairNics(result.nics);
            setPinnedPairAddress(result.pinned);
          }
        })
        .catch((error: unknown) => {
          logger.warn(`${LOG_SCOPE} 加载配对网卡候选失败`, {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    if (bridge.getWebRemoteControlExternalRelay) {
      void bridge
        .getWebRemoteControlExternalRelay()
        .then((url) => {
          if (!cancelled) {
            setExternalRelayUrl(url);
            setExternalRelayDraft(url);
          }
        })
        .catch((error: unknown) => {
          logger.warn(`${LOG_SCOPE} 读取自建中继地址失败`, {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 钉选变更即时生效（main 侧重建活动会话配对 URL，状态推送会带回新 qrUrl/connectUrl）。
  const handlePairAddressChange = useCallback(
    async (address: string) => {
      const bridge = getWebRemoteControlBridge();
      if (!bridge?.setWebRemoteControlPairAddress) {
        return;
      }
      const previous = pinnedPairAddress;
      setPinnedPairAddress(address);
      try {
        const result = await bridge.setWebRemoteControlPairAddress(address);
        if (!result.valid) {
          setPinnedPairAddress(previous);
          toast(intl.formatMessage({ id: "webRemoteControl.pairNic.setFailed" }, { error: result.error ?? "" }));
          return;
        }
        toast(intl.formatMessage({ id: "webRemoteControl.pairNic.setSaved" }));
      } catch (error) {
        setPinnedPairAddress(previous);
        const message = error instanceof Error ? error.message : String(error);
        toast(intl.formatMessage({ id: "webRemoteControl.pairNic.setFailed" }, { error: message }));
      }
    },
    [intl.formatMessage, pinnedPairAddress],
  );

  /** 当前配对地址（只展示 origin+path，不带配对参数；从 connectUrl 派生）。 */
  const pairAddressOrigin = useMemo(() => {
    if (!status.connectUrl) {
      return null;
    }
    try {
      const url = new URL(status.connectUrl);
      return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
    } catch {
      return null;
    }
  }, [status.connectUrl]);

  const statusTitle = useMemo(
    () => resolveStatusTitle(status, intl.formatMessage),
    [intl.formatMessage, status],
  );
  const statusDetail = useMemo(
    () => resolveStatusDetail(status, intl.formatMessage),
    [intl.formatMessage, status],
  );
  const failureMessage = useMemo(
    () => resolveWebRemoteControlFailureMessage(status.failure, intl.formatMessage),
    [intl.formatMessage, status.failure],
  );
  const statusTag = useMemo(
    () => resolveStatusTag(status, intl.formatMessage),
    [intl.formatMessage, status],
  );
  const statusDotClassName = resolveStatusDotClassName(status);

  const context: WebRemoteControlContext = useMemo(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      ...(initialTaskId ? { initialTaskId } : {}),
    }),
    [initialTaskId, remoteSessionId, workspaceIdentity, workspacePath],
  );

  // 自建中继保存（spec §1.11）：落盘后立即 rotate 重注册——换中继后旧链接失效，无需二次确认
  // （保存动作本身就是显式变更；与「刷新二维码」的确认弹窗语义不同）。
  const handleSaveExternalRelay = useCallback(async () => {
    const bridge = getWebRemoteControlBridge();
    if (!bridge?.setWebRemoteControlExternalRelay || externalRelayUrl === null) {
      return;
    }
    setExternalRelayBusy(true);
    try {
      const result = await bridge.setWebRemoteControlExternalRelay(externalRelayDraft);
      if (!result.valid) {
        toast(intl.formatMessage({ id: "webRemoteControl.externalRelay.setFailed" }, { error: result.error ?? "" }));
        return;
      }
      setExternalRelayUrl(externalRelayDraft.trim());
      if (bridge.refreshWebRemoteControlPairing) {
        const next = await bridge.refreshWebRemoteControlPairing(context);
        if (next.status !== "cancelled") {
          publishWebRemoteControlStatus(next);
        }
      }
      toast(intl.formatMessage({ id: "webRemoteControl.externalRelay.saved" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(intl.formatMessage({ id: "webRemoteControl.externalRelay.setFailed" }, { error: message }));
    } finally {
      setExternalRelayBusy(false);
    }
  }, [context, externalRelayDraft, externalRelayUrl, intl.formatMessage]);

  // 打开即自动启动：已有同 workspace/远程身份会话或手机已连接则复用，否则 start（spec §1.2）。
  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    void (async () => {
      setBusy(true);
      const bridge = getWebRemoteControlBridge();
      if (!bridge) {
        setBusy(false);
        return;
      }
      try {
        const current = await bridge.getWebRemoteControlStatus();
        let next: WebRemoteControlStatusSnapshot;
        if (isSameContextSession(current, context) || isMobileConnectedSession(current)) {
          next = current;
        } else {
          const started = await bridge.startWebRemoteControl(context);
          next = started.status === "cancelled" ? { status: "idle" } : started;
        }
        if (cancelled) {
          return;
        }
        publishWebRemoteControlStatus(next);
        logger.info(`${LOG_SCOPE} Web 远程控制状态已同步`, {
          workspacePath,
          workspaceIdentity: workspaceIdentity ?? "none",
          remoteSessionId: remoteSessionId ?? "none",
          initialTaskId: initialTaskId ?? "none",
          status: next.status,
          sessionId: next.sessionId ?? "none",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (cancelled) {
          return;
        }
        publishWebRemoteControlStatus({ status: "error", workspacePath, error: message });
        toast(intl.formatMessage({ id: "webRemoteControl.startFailed" }, { error: message }));
        logger.error(`${LOG_SCOPE} 启动 Web 远程控制失败`, {
          workspacePath,
          workspaceIdentity: workspaceIdentity ?? "none",
          remoteSessionId: remoteSessionId ?? "none",
          initialTaskId: initialTaskId ?? "none",
          error: message,
        });
      } finally {
        if (!cancelled) {
          setBusy(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    context,
    intl.formatMessage,
    initialTaskId,
    open,
    remoteSessionId,
    workspaceIdentity,
    workspacePath,
  ]);

  // 二维码：状态里的 qrUrl 变化才重画；margin/width 与官方一致（附录C §4.2）。
  useEffect(() => {
    if (!status.qrUrl) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    setQrDataUrl(null);
    void toDataURL(status.qrUrl, { margin: 1, width: 320 })
      .then((dataUrl) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
        }
      })
      .catch((error: unknown) => {
        logger.error(
          `${LOG_SCOPE} 生成二维码失败`,
          error instanceof Error ? error.message : String(error),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [status.qrUrl]);

  const handleCopyLink = useCallback(async () => {
    if (!status.connectUrl) {
      return;
    }
    try {
      await navigator.clipboard.writeText(status.connectUrl);
      toast(intl.formatMessage({ id: "webRemoteControl.copyLink.copied" }));
      logger.info(`${LOG_SCOPE} 已复制 Web 远程控制链接`, {
        workspacePath,
        remoteSessionId: remoteSessionId ?? "none",
        sessionId: status.sessionId ?? "none",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(intl.formatMessage({ id: "webRemoteControl.copyLinkFailed" }, { error: message }));
      logger.error(`${LOG_SCOPE} 复制 Web 远程控制链接失败`, message);
    }
  }, [intl.formatMessage, remoteSessionId, status.connectUrl, status.sessionId, workspacePath]);

  // 刷新二维码会 rotate deviceSid/passHash，旧链接立刻失效，必须二次确认（spec §1.3）。
  const handleRefreshQr = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "webRemoteControl.refreshQr.confirmTitle" }),
      description: intl.formatMessage({ id: "webRemoteControl.refreshQr.confirmDescription" }),
      confirmLabel: intl.formatMessage({ id: "webRemoteControl.refreshQr" }),
    });
    if (!confirmed) {
      return;
    }
    setBusy(true);
    const bridge = getWebRemoteControlBridge();
    try {
      if (!bridge) {
        return;
      }
      const next = await bridge.refreshWebRemoteControlPairing(context);
      if (next.status === "cancelled") {
        return;
      }
      publishWebRemoteControlStatus(next);
      toast(intl.formatMessage({ id: "webRemoteControl.refreshQr.success" }));
      logger.info(`${LOG_SCOPE} 已刷新 Web 远程控制二维码`, {
        workspacePath,
        remoteSessionId: remoteSessionId ?? "none",
        sessionId: next.sessionId ?? "none",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(intl.formatMessage({ id: "webRemoteControl.refreshQr.failed" }, { error: message }));
      logger.error(`${LOG_SCOPE} 刷新 Web 远程控制二维码失败`, {
        workspacePath,
        remoteSessionId: remoteSessionId ?? "none",
        error: message,
      });
    } finally {
      setBusy(false);
    }
  }, [confirmDialog, context, intl.formatMessage, remoteSessionId, workspacePath]);

  // 停止无确认（附录C §1.8），手机侧会收到 desktop-disconnected。
  const handleStop = useCallback(async () => {
    setBusy(true);
    const bridge = getWebRemoteControlBridge();
    try {
      if (!bridge) {
        return;
      }
      await bridge.stopWebRemoteControl();
      publishWebRemoteControlStatus({ status: "idle" });
      onOpenChange(false);
      toast(intl.formatMessage({ id: "webRemoteControl.stopSuccess" }));
      logger.info(`${LOG_SCOPE} 已关闭 Web 远程控制`, {
        workspacePath,
        remoteSessionId: remoteSessionId ?? "none",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(intl.formatMessage({ id: "webRemoteControl.stopFailed" }, { error: message }));
      logger.error(`${LOG_SCOPE} 关闭 Web 远程控制失败`, message);
    } finally {
      setBusy(false);
    }
  }, [intl.formatMessage, onOpenChange, remoteSessionId, workspacePath]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      logger.info(`${LOG_SCOPE} 弹层开关状态变化`, {
        workspacePath,
        remoteSessionId: remoteSessionId ?? "none",
        nextOpen,
      });
      onOpenChange(nextOpen);
    },
    [onOpenChange, remoteSessionId, workspacePath],
  );

  const handleCloseButtonClick = useCallback(() => {
    logger.info(`${LOG_SCOPE} 用户点击右上角关闭按钮`, {
      workspacePath,
      remoteSessionId: remoteSessionId ?? "none",
      sessionId: status.sessionId ?? "none",
      status: status.status,
    });
    handleOpenChange(false);
  }, [handleOpenChange, remoteSessionId, status.sessionId, status.status, workspacePath]);

  const handleOpenChannel = useCallback(
    (provider: string) => {
      setEntryProvider(provider);
      setBotsOpen(true);
      logger.info(`${LOG_SCOPE} 打开 Bot Channel 配置入口`, {
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? "none",
        provider,
      });
    },
    [workspaceIdentity, workspacePath],
  );

  const handleOpenBots = useCallback(() => {
    setEntryProvider(null);
    setBotsOpen(true);
    logger.info(`${LOG_SCOPE} 打开 Bots 总配置入口`, {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
    });
  }, [workspaceIdentity, workspacePath]);

  const failureSecondaryMessage =
    failureMessage && status.failure?.message && status.failure.message !== failureMessage
      ? status.failure.message
      : null;

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="max-h-[calc(100vh-6rem)] max-w-4xl gap-0 overflow-hidden rounded-2xl p-0"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-2 right-2 enabled:cursor-pointer [app-region:no-drag]"
            onClick={handleCloseButtonClick}
          >
            <X />
            <span className="sr-only">Close</span>
          </Button>
          <div
            data-testid="web-remote-control-dialog-scroll"
            className="max-h-[calc(100vh-6rem)] min-h-0 overflow-y-auto p-5"
          >
            <DialogHeader className="space-y-2 pr-8">
              <div className="flex items-center gap-2">
                <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface text-primary">
                  <MonitorSmartphone className="size-5" />
                </div>
                <div className="space-y-1">
                  <DialogTitle>{intl.formatMessage({ id: "webRemoteControl.title" })}</DialogTitle>
                  <DialogDescription>
                    {intl.formatMessage({ id: "webRemoteControl.description" })}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div
              data-testid="web-remote-control-main-grid"
              className="mt-5 grid gap-4 md:grid-cols-[minmax(0,1.45fr)_minmax(300px,1fr)]"
            >
              <section
                data-testid="web-remote-control-scan-card"
                className="flex min-h-[360px] flex-col rounded-xl border border-border bg-card p-4"
              >
                <div className="mb-4 flex items-start gap-2">
                  <Smartphone className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
                  <div className="min-w-0 space-y-1">
                    <div className="text-ui-base font-medium text-foreground">
                      {intl.formatMessage({ id: "webRemoteControl.mobileQr.title" })}
                    </div>
                    <p className="text-ui-base/relaxed text-foreground-subtle">
                      {intl.formatMessage({ id: "webRemoteControl.mobileQr.description" })}
                    </p>
                  </div>
                </div>
                <div
                  data-testid="web-remote-control-connection-card"
                  className="mb-3 rounded-lg bg-surface px-3 py-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <div
                          className={cn(
                            "text-ui-base font-medium",
                            resolveStatusTitleClassName(status),
                          )}
                        >
                          {statusTitle}
                        </div>
                        <div className="flex min-w-0 items-center gap-1.5 rounded-full bg-card px-2 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                          <span
                            className={cn("size-1.5 shrink-0 rounded-full", statusDotClassName)}
                          />
                          <span className="truncate">{statusTag}</span>
                        </div>
                      </div>
                      <div className="text-ui-base/relaxed text-foreground-subtle">
                        {statusDetail}
                      </div>
                    </div>
                    {busy ? (
                      <LoaderCircle className="size-4 animate-spin text-foreground-subtle" />
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="default"
                        className="shrink-0 gap-2 enabled:cursor-pointer"
                        onClick={() => void handleStop()}
                        disabled={status.status === "idle"}
                      >
                        <Unplug className="size-3.5" />
                        {intl.formatMessage({ id: "webRemoteControl.stop" })}
                      </Button>
                    )}
                  </div>
                  {failureMessage ? (
                    <div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-ui-base/relaxed text-destructive">
                      <p>{failureMessage}</p>
                      {failureSecondaryMessage ? (
                        <p className="mt-1 text-ui-xs/relaxed opacity-80">
                          {failureSecondaryMessage}
                        </p>
                      ) : null}
                    </div>
                  ) : status.error ? (
                    <p className="mt-3 text-ui-base/relaxed text-destructive">{status.error}</p>
                  ) : null}
                  <div
                    data-testid="web-remote-control-copy-link-row"
                    className="mt-3 flex min-h-10 flex-wrap items-center gap-3 border-t border-border pt-3"
                  >
                    <div className="min-w-48 flex-1 text-ui-base/relaxed text-foreground-subtle">
                      {intl.formatMessage({ id: "webRemoteControl.copyLink.description" })}
                      {pairAddressOrigin ? (
                        <span
                          data-testid="web-remote-control-pair-address"
                          className="ml-1 font-mono text-ui-sm text-foreground"
                        >
                          {pairAddressOrigin}
                        </span>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="default"
                      className="shrink-0 gap-2 enabled:cursor-pointer"
                      onClick={() => void handleRefreshQr()}
                      disabled={busy}
                    >
                      <RefreshCw className="size-3.5" />
                      {intl.formatMessage({ id: "webRemoteControl.refreshQr" })}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="default"
                      className="shrink-0 gap-2 enabled:cursor-pointer"
                      onClick={() => void handleCopyLink()}
                      disabled={!status.connectUrl || busy}
                    >
                      <Copy className="size-3.5" />
                      {intl.formatMessage({ id: "webRemoteControl.copyLink" })}
                    </Button>
                  </div>
                  {pairNics && pairNics.length > 0 ? (
                    <div
                      data-testid="web-remote-control-pair-nic-row"
                      className="mt-2 flex min-h-10 flex-wrap items-center gap-3"
                    >
                      <label
                        className="shrink-0 text-ui-sm text-foreground-subtle"
                        htmlFor="web-remote-control-pair-nic-select"
                      >
                        {intl.formatMessage({ id: "webRemoteControl.pairNic.label" })}
                      </label>
                      <select
                        id="web-remote-control-pair-nic-select"
                        className="min-w-48 flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-ui-sm text-foreground"
                        value={pinnedPairAddress}
                        onChange={(event) => void handlePairAddressChange(event.target.value)}
                      >
                        <option value="">
                          {intl.formatMessage({ id: "webRemoteControl.pairNic.auto" })}
                        </option>
                        {pairNics.map((nic) => (
                          <option key={nic.ip} value={nic.ip}>
                            {`${nic.ip}（${nic.label}${nic.isDefault ? ` · ${intl.formatMessage({ id: "webRemoteControl.pairNic.default" })}` : ""}）`}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  {externalRelayUrl !== null ? (
                    <div
                      data-testid="web-remote-control-external-relay-row"
                      className="mt-2 flex min-h-10 flex-wrap items-center gap-3"
                    >
                      <label
                        className="shrink-0 text-ui-sm text-foreground-subtle"
                        htmlFor="web-remote-control-external-relay-input"
                      >
                        {intl.formatMessage({ id: "webRemoteControl.externalRelay.label" })}
                      </label>
                      <input
                        id="web-remote-control-external-relay-input"
                        type="text"
                        className="min-w-48 flex-1 rounded-md border border-border bg-card px-2 py-1.5 font-mono text-ui-sm text-foreground"
                        placeholder={intl.formatMessage({ id: "webRemoteControl.externalRelay.placeholder" })}
                        value={externalRelayDraft}
                        onChange={(event) => setExternalRelayDraft(event.target.value)}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="default"
                        className="shrink-0 enabled:cursor-pointer"
                        onClick={() => void handleSaveExternalRelay()}
                        disabled={externalRelayBusy || externalRelayDraft.trim() === externalRelayUrl}
                      >
                        <Globe className="size-3.5" />
                        {intl.formatMessage({ id: "webRemoteControl.externalRelay.save" })}
                      </Button>
                    </div>
                  ) : null}
                </div>
                <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-border bg-background-alt p-4">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt={intl.formatMessage({ id: "webRemoteControl.qrAlt" })}
                      className="size-64 max-w-full rounded-lg bg-white p-3"
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-3 text-center text-ui-base text-foreground-subtle">
                      <LoaderCircle className="size-5 animate-spin" />
                      <span>{intl.formatMessage({ id: "webRemoteControl.generating" })}</span>
                    </div>
                  )}
                </div>
              </section>
              <section className="flex min-h-[360px] flex-col rounded-xl border border-border bg-card p-4">
                <div className="mb-4 flex items-start gap-2">
                  <Bot className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
                  <div className="min-w-0 space-y-1">
                    <div className="text-ui-base font-medium text-foreground">
                      {intl.formatMessage({ id: "webRemoteControl.botChannel.title" })}
                    </div>
                    <p className="text-ui-base/relaxed text-foreground-subtle">
                      {intl.formatMessage({ id: "webRemoteControl.botChannel.description" })}
                    </p>
                  </div>
                </div>
                <div className="grid min-h-0 flex-1 gap-3">
                  {BOT_CHANNEL_PROVIDERS.map(({ provider }) => {
                    const regionTagKey = resolveRegionTagKey(provider);
                    return (
                      <button
                        key={provider}
                        type="button"
                        className="flex min-h-0 cursor-pointer items-start gap-3 rounded-lg border border-transparent bg-surface px-3 py-3 text-left transition-colors hover:border-input-border-focused hover:bg-surface-hover focus-visible:border-input-border-focused"
                        onClick={() => handleOpenChannel(provider)}
                      >
                        <BotChannelIcon provider={provider} className="size-12 shrink-0" />
                        <span className="min-w-0 flex-1 space-y-1">
                          <span className="flex min-w-0 items-center gap-1.5 text-ui-base font-medium text-foreground">
                            <span className="min-w-0 truncate">
                              {intl.formatMessage({
                                id: `webRemoteControl.botChannel.${provider}.title`,
                              })}
                            </span>
                            {regionTagKey ? (
                              <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
                                {intl.formatMessage({ id: regionTagKey })}
                              </span>
                            ) : null}
                          </span>
                          <span className="block text-ui-base/relaxed text-foreground-subtle">
                            {intl.formatMessage({
                              id: `webRemoteControl.botChannel.${provider}.description`,
                            })}
                          </span>
                          <span className="block text-ui-base font-medium text-primary">
                            {intl.formatMessage({ id: "webRemoteControl.botChannel.configure" })}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    data-testid="web-remote-control-open-bots"
                    className="w-full justify-center gap-2 enabled:cursor-pointer"
                    onClick={handleOpenBots}
                  >
                    <Bot className="size-3.5" />
                    {intl.formatMessage({ id: "webRemoteControl.botChannel.manageBots" })}
                  </Button>
                </div>
              </section>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <BotsDialog
        open={botsOpen}
        onOpenChange={setBotsOpen}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        entryProvider={entryProvider}
      />
    </>
  );
});
