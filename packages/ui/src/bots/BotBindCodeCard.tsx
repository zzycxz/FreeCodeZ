/**
 * 绑定码卡（附录C §1.3 绑定码卡）：`/bind <CODE>` 命令 + 复制 + 三步指引 + 倒计时进度条。
 * 进度条三色阈值：剩余 ≤10% 红、≤10s 黄、过期灰，其余主色；250ms tick 由弹窗驱动数值。
 */
import { Clock3, Copy, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BotPanelCard } from "@/bots/BotHeader.js";
import type { BotBindCodeView } from "@/bots/botsApi.js";

/** 绑定码 UI 状态：附录C §1.3 的 `T`（含 TTL 与创建时刻，供 250ms 倒计时换算）。 */
export interface BotBindCodeState extends BotBindCodeView {
  botId: string;
  createdAt: number;
  ttlMs: number;
}

export function formatBindCodeRemaining(remainingMs: number): string {
  return `${Math.max(0, Math.ceil(remainingMs / 1000))}s`;
}

export function BotBindCodeCard({
  bindCommand,
  bindExpired,
  bindRemainingMs,
  bindCountdownProgress,
  onCreateBindCode,
  onCopyBindCommand,
}: {
  bindCommand: string;
  bindExpired: boolean;
  bindRemainingMs: number;
  bindCountdownProgress: number;
  onCreateBindCode: () => void;
  onCopyBindCommand: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <BotPanelCard>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "bots.bindCommand" })}
          </div>
          <div className="mt-1 text-ui-base leading-5 text-foreground-subtle">
            {intl.formatMessage({ id: "bots.bindCommandGuide" })}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onCreateBindCode}>
          <QrCode className="size-3" />
          {intl.formatMessage({ id: "bots.setup.refreshBindCode" })}
        </Button>
      </div>
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md bg-surface px-2 py-1.5">
        <span
          className={cn(
            "min-w-0 break-all font-mono text-ui-base leading-5",
            bindExpired ? "text-foreground-subtle" : "text-foreground",
          )}
        >
          {bindCommand}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCopyBindCommand}
          disabled={bindExpired}
          title={intl.formatMessage({ id: "bots.copyBindCommand" })}
        >
          <Copy className="size-4" />
          {intl.formatMessage({ id: "bots.copyBindCommand" })}
        </Button>
      </div>
      <ol className="mt-2 list-decimal space-y-1 pl-4 text-ui-base leading-5 text-foreground-subtle">
        <li>{intl.formatMessage({ id: "bots.bindCommandStep.copy" })}</li>
        <li>{intl.formatMessage({ id: "bots.bindCommandStep.openChat" })}</li>
        <li>{intl.formatMessage({ id: "bots.bindCommandStep.send" })}</li>
      </ol>
      <div className="mt-2 flex items-center gap-2 text-ui-base text-foreground-subtle">
        <Clock3 className="size-3" />
        {bindExpired
          ? intl.formatMessage({ id: "bots.bindCodeExpired" })
          : intl.formatMessage(
              { id: "bots.bindCodeExpires" },
              { time: formatBindCodeRemaining(bindRemainingMs) },
            )}
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface">
        <div
          className={cn(
            "h-full origin-left rounded-full transition-transform duration-300 ease-linear",
            bindExpired
              ? "bg-border"
              : bindCountdownProgress <= 10
                ? "bg-destructive"
                : bindRemainingMs <= 10_000
                  ? "bg-warning"
                  : "bg-primary",
          )}
          style={{ transform: `scaleX(${bindCountdownProgress / 100})` }}
        />
      </div>
    </BotPanelCard>
  );
}
