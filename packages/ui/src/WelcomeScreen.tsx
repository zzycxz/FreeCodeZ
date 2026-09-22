/**
 * WelcomeScreen —— 首次打开的「添加供应商」接入面（model-provider-intake R2 + §P1 三步向导）。
 *
 * 原 OAuth / API Key 登录页已随 bigmodel+zai 账号族整体移除；冷启动首屏承载
 * ProviderIntakeWizard 三步向导（选厂商 → 填 key 验证 → 选模型 → 原子落盘，
 * spec: docs/spec/model-provider-intake-and-expansion.md §P1），完成即供应商可用，
 * 不再产生空壳态；「稍后设置」跳过后进入主界面。
 */
import { Button } from "./components/ui/button.js";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import { ThemeHeroVisual } from "./openWorkspacePageThemeHero.js";
import {
  ProviderDetailFeedbackBoundary,
} from "./settings/model-provider-section/ProviderDetailFeedback.js";
import { ProviderIntakeWizard } from "./settings/model-provider-section/ProviderIntakeWizard.js";

export type LoginCompleteReason = "done" | "skip";

interface WelcomeScreenProps {
  onComplete: (reason: LoginCompleteReason) => void | Promise<void>;
}

export function WelcomeScreen({ onComplete }: WelcomeScreenProps) {
  const { intl } = useZCodeIntl();
  return (
    <main className="relative flex h-full min-h-dvh items-center justify-center overflow-hidden bg-background px-4 py-6 text-foreground sm:px-6">
      <ThemeHeroVisual className="absolute inset-0" />
      <div className="pointer-events-none absolute left-0 top-0 right-0 z-10 flex h-12 w-full items-center [app-region:drag]" />
      <section className="relative z-10 w-full flex max-h-[88dvh] flex-col gap-6 max-w-2xl rounded-2xl border border-popover-border bg-background p-8 text-ui-base/relaxed shadow-md sm:p-10">
        {/* 26+ 模板后内容超高：内容区自滚、跳过按钮固定卡底（实测 bug 修复）。 */}
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <ProviderDetailFeedbackBoundary>
            <ProviderIntakeWizard onComplete={onComplete} />
          </ProviderDetailFeedbackBoundary>
        </div>
        <Button
          type="button"
          variant="link"
          className="h-7 w-full shrink-0 text-ui-base text-foreground-subtle hover:text-foreground"
          onClick={() => void onComplete("skip")}
        >
          {intl.formatMessage({ id: "login.skip" })}
        </Button>
      </section>
    </main>
  );
}
