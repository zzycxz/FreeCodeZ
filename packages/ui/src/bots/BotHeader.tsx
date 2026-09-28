/**
 * 机器人详情面板组骨架 + 头部卡（附录C §1.3 `Xrn`）。
 *
 * 面板壳（BotPanelGroup/BotPanelRow/BotPanelCard）与头部卡同属详情面板组的静态骨架，
 * 集中在本叶子模块导出，凭据卡/颗粒度/工作区/删除行共用，避免每个面板各画一套壳。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { BotConfig } from "@zcode/shared/bots";
import { Clock3 } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { BotChannelIcon } from "@/bots/BotChannelIcon.js";
import {
  isFeishuLikeProvider,
  resolveBotDisplayName,
  type BotRuntimeView,
} from "@/bots/botsApi.js";

const LOG_SCOPE = "[BotsDialog]";

/** 面板内嵌卡（附录C §1.3 `S3`）：嵌在 rounded-xl 面板组内，故降级 rounded-lg。 */
export function BotPanelCard({ children }: { children: ReactNode }) {
  return <div className="rounded-lg bg-background p-3">{children}</div>;
}

/** 面板组容器（附录C §1.3 `Q1`）：详情面板的分组卡。 */
export function BotPanelGroup({ children }: { children: ReactNode }) {
  return (
    <Card className="overflow-hidden rounded-xl border-border py-0 shadow-none">
      <CardContent className="space-y-0 px-0">{children}</CardContent>
    </Card>
  );
}

/** 面板行（附录C §1.3 `Z1`）：左文案 + 右控件，detail 挂在行下方。 */
export function BotPanelRow({
  label,
  description,
  control,
  detail,
  controlLayout = "default",
}: {
  label: string;
  description?: string;
  control: ReactNode;
  detail?: ReactNode;
  controlLayout?: "default" | "wide";
}) {
  return (
    <div className="border-t border-border px-4 py-3 first:border-t-0">
      <div
        className={cn(
          "grid items-center gap-4",
          controlLayout === "wide"
            ? "grid-cols-1 sm:grid-cols-[minmax(0,1fr)_280px]"
            : "grid-cols-[minmax(0,1fr)_192px]",
        )}
      >
        <div className="min-w-0">
          <div className="text-ui-base font-medium text-foreground">{label}</div>
          {description ? (
            <div className="mt-1 text-ui-base leading-6 text-foreground-subtle">{description}</div>
          ) : null}
        </div>
        <div className="flex w-full flex-nowrap items-center justify-end gap-2">
          {controlLayout === "wide" ? detail : null}
          {control}
        </div>
      </div>
      {detail && controlLayout !== "wide" ? <div className="mt-3">{detail}</div> : null}
    </div>
  );
}

/**
 * 运行状态文案（附录C §1.3 `Krn`）：优先 host messageId（UI 翻译），其次 message、status。
 * 最后一档保留官方的字面 enabled/disabled 兜底（真实响应总会带 status）。
 */
export function resolveBotRuntimeLabel(
  runtime: BotRuntimeView | undefined,
  botEnabled: boolean,
  formatMessage: IntlInstance["formatMessage"],
): string {
  if (runtime?.messageId) {
    return formatMessage({ id: runtime.messageId });
  }
  if (runtime?.message) {
    return runtime.message;
  }
  if (runtime?.status) {
    return runtime.status;
  }
  return botEnabled ? "enabled" : "disabled";
}

/** 状态圆点（附录C §1.3 `qrn`）：error 红 / polling|connected 绿 / 启用灰 / 其余描边灰。 */
export function resolveBotStatusDotClassName(
  runtime: BotRuntimeView | undefined,
  botEnabled: boolean,
): string {
  if (runtime?.status === "error") {
    return "bg-destructive";
  }
  if (runtime?.status === "polling" || runtime?.status === "connected") {
    return "bg-success";
  }
  return botEnabled ? "bg-foreground-subtle" : "bg-border";
}

export function BotHeader({
  bot,
  runtime,
  renaming,
  nameDraft,
  onStartRename,
  onNameDraftChange,
  onCommitNameDraft,
  onCancelRename,
  onPatchBot,
}: {
  bot: BotConfig;
  runtime: BotRuntimeView | undefined;
  renaming: boolean;
  nameDraft: string;
  onStartRename: () => void;
  onNameDraftChange: (value: string) => void;
  onCommitNameDraft: () => void;
  onCancelRename: () => void;
  onPatchBot: (patch: Partial<BotConfig>) => void;
}) {
  const { intl } = useZCodeIntl();
  const measureRef = useRef<HTMLButtonElement | null>(null);
  const compositionRef = useRef(false);
  const [draftWidth, setDraftWidth] = useState<number | null>(null);
  const fallbackName = intl.formatMessage({ id: "bots.newBot.fallbackName" });
  const displayName = resolveBotDisplayName(nameDraft, fallbackName);
  const isBound = Boolean(bot.providerUserId);
  const hasError = runtime?.status === "error";

  const statusLabel = hasError
    ? intl.formatMessage({
        id: isFeishuLikeProvider(bot.provider)
          ? bot.provider === "lark"
            ? "bots.runtime.larkConnectionFailed"
            : "bots.runtime.feishuConnectionFailed"
          : "bots.runtime.connectionFailed",
      })
    : isBound
      ? resolveBotRuntimeLabel(runtime, bot.enabled, intl.formatMessage)
      : intl.formatMessage({ id: "bots.unbound" });

  // 内联重命名：按原名锁宽，避免输入中文时文本宽度抖动（附录C §1.3 `Xrn`）。
  useLayoutEffect(() => {
    if (!renaming) {
      setDraftWidth(null);
      return;
    }
    const measure = measureRef.current;
    if (!measure) {
      return;
    }
    const update = () => {
      setDraftWidth(Math.ceil(measure.getBoundingClientRect().width));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [displayName, renaming]);

  const handleInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        if (compositionRef.current) {
          logger.debug(`${LOG_SCOPE} ignore bot name enter during IME`, { botId: bot.id });
          return;
        }
        event.currentTarget.blur();
        return;
      }
      if (event.key === "Escape") {
        onCancelRename();
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [bot.id, onCancelRename],
  );

  const handleBlur = useCallback(() => {
    onCommitNameDraft();
  }, [onCommitNameDraft]);

  useEffect(() => {
    compositionRef.current = false;
  }, [renaming]);

  const nameBlock = renaming ? (
    <label
      className="relative inline-block min-w-6 max-w-md align-middle"
      style={draftWidth ? { width: `${draftWidth}px` } : undefined}
    >
      <span className="sr-only">{intl.formatMessage({ id: "bots.name" })}</span>
      <button
        ref={measureRef}
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-0 invisible max-w-md overflow-hidden rounded-sm px-1 text-left text-ui-lg font-medium"
        style={{ whiteSpace: "pre" }}
      >
        {displayName}
      </button>
      <input
        autoFocus
        className="w-full min-w-0 truncate rounded-sm border-0 bg-transparent px-1 py-0 text-left text-ui-lg font-medium leading-normal text-foreground outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-input-border-focused"
        value={nameDraft}
        onBlur={handleBlur}
        onChange={(event) => onNameDraftChange(event.target.value)}
        onCompositionEnd={() => {
          compositionRef.current = false;
        }}
        onCompositionStart={() => {
          compositionRef.current = true;
        }}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={handleInputKeyDown}
        placeholder={fallbackName}
      />
    </label>
  ) : (
    <button
      type="button"
      className="min-w-0 max-w-md truncate rounded-sm px-1 text-left text-ui-lg font-medium hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
      onClick={onStartRename}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          onStartRename();
        }
      }}
    >
      {displayName}
    </button>
  );

  return (
    <div className="flex items-center gap-3 px-2 pb-2">
      <BotChannelIcon provider={bot.provider} className="size-12 shrink-0 text-foreground-subtle" />
      <div className="min-w-0 flex-1 space-y-1">
        {nameBlock}
        <span className="inline-flex items-center gap-2 text-foreground-subtle">
          {isBound || hasError ? (
            <span
              className={cn(
                "size-1.5 rounded-full",
                resolveBotStatusDotClassName(runtime, bot.enabled),
              )}
            />
          ) : (
            <Clock3 className="size-3 text-foreground-subtle" />
          )}
          {statusLabel}
        </span>
      </div>
      <div className="shrink-0">
        <Switch
          checked={bot.enabled}
          onCheckedChange={(checked) => onPatchBot({ enabled: checked })}
        />
      </div>
    </div>
  );
}
