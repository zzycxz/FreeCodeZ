import { X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { MobileSidePaneContent } from "./mobileRemoteTypes.js";

// 手机端右抽屉（附录C §7.3 data-mobile-side-pane-overlay）：w-[min(88vw,28rem)]，
// 遮罩 + 面板 200ms 过渡；抽屉承载 side pane 面板（官方为 side-pane tab 集合，
// FreeCodeZ 当前抽屉内容由宿主注入 MobileSidePaneContent，见 MobileShell）。

export function MobileSidePaneDrawer({
  open,
  content,
  onClose,
}: {
  open: boolean;
  content: MobileSidePaneContent | null;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const { formatMessage } = intl;
  return (
    <div
      data-mobile-side-pane-overlay="true"
      className={cn("fixed inset-0 z-40", open ? "pointer-events-auto" : "pointer-events-none")}
    >
      <div
        className={cn(
          "absolute inset-0 bg-black/60 transition-opacity duration-200",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={cn(
          "absolute inset-y-0 right-0 flex w-[min(88vw,28rem)] flex-col border-l border-border bg-popover transition-transform duration-200",
          open ? "translate-x-0" : "translate-x-full",
        )}
        aria-hidden={!open || undefined}
        inert={open ? undefined : true}
      >
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          <h2 className="min-w-0 flex-1 truncate text-ui-base font-medium">
            {content?.title ?? formatMessage({ id: "sidePane.togglePanel" })}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={formatMessage({ id: "sidePane.collapse" })}
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 text-ui-sm text-foreground-subtle">
          {content?.body ?? formatMessage({ id: "sidePane.openTabDescription" })}
        </div>
      </aside>
    </div>
  );
}
