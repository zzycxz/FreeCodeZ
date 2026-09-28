import { Palette } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTheme, type Theme } from "@/useTheme.js";

// 手机端主题菜单（附录C §7.6）：RadioGroup 三选 system / zai-dark / zai-light，
// 持久化 localStorage `zcode-theme`（useTheme 统一 applyTheme：html class dark|theme-zai-*）。

/** 主题白名单（官方 u5t）：system / zai-dark / zai-light，其余值由 useTheme 归一。 */
export const MOBILE_THEME_OPTIONS: readonly Theme[] = ["system", "zai-dark", "zai-light"];

const THEME_LABEL_IDS: Record<string, string> = {
  system: "sidebar.settings.systemDefault",
  "zai-dark": "sidebar.settings.theme.zai-dark",
  "zai-light": "sidebar.settings.theme.zai-light",
};

export function MobileThemeMenu({ className }: { className?: string }) {
  const { intl } = useZCodeIntl();
  const { formatMessage } = intl;
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={className}
          aria-label={formatMessage({ id: "webRemoteControl.themeMenu.trigger" })}
          title={formatMessage({ id: "webRemoteControl.themeMenu.trigger" })}
        >
          <Palette className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => {
            if (MOBILE_THEME_OPTIONS.includes(value as Theme)) {
              setTheme(value as Theme);
            }
          }}
        >
          {MOBILE_THEME_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {formatMessage({ id: THEME_LABEL_IDS[option] ?? option })}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
