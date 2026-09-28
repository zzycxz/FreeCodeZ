import { useEffect, useState } from "react";
import type { Root as ReactRoot } from "react-dom/client";
import { AppErrorBoundary, MobileShell, ZCodeIntlProvider } from "@zcode/ui/mobile";
import type { IServiceAccessor } from "@zcode/services";
import { WEB_DEFAULT_THEME, resolveWebInitialTheme } from "../webThemeSeed.js";
import { createWebPlatform } from "../webPlatform.js";
import {
  createRelayMobileSession,
  type RelayMobileSessionHandle,
} from "./relayMobileSession.js";

// 手机远控页入口（附录C §7）：读 URL 参数（sid&hash&t&mid&name&app_version，可被 relay 注入的
// __RELAY_CONFIG__ 覆盖 wsUrl）→ relay 握手（mobile_hello）→ MobileShell（home 全量 + chat 会话面）。
// 桥服务面就绪后把同一 RemoteServiceAccess 交给 ZCodeIntlProvider（preferSettingServiceLocale：
// 语言以桌面 setting.json 为准，见 IntlProvider 注释），实现桌面/手机语言一致。

interface RelayPageConfig {
  sid?: string;
  hash?: string;
  wsUrl?: string;
  t?: string;
  mid?: string;
  name?: string;
  appVersion?: string;
}

function readInjectedConfig(): RelayPageConfig {
  return (globalThis.window as unknown as { __RELAY_CONFIG__?: RelayPageConfig }).__RELAY_CONFIG__ ?? {};
}

function resolveDefaultWsUrl(): string {
  const protocol = globalThis.location?.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${globalThis.location?.host ?? "127.0.0.1:37843"}/ws`;
}

/** 主题预应用：与 main.tsx 同一段规则（默认 Zai dark，system 跟随系统），避免首屏闪白。 */
function seedMobileTheme(): void {
  const saved = resolveWebInitialTheme({
    storedTheme: globalThis.localStorage?.getItem("zcode-theme"),
    defaultTheme: WEB_DEFAULT_THEME,
  });
  const resolved =
    saved === "system"
      ? globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : saved === "dark" || saved === "zai-dark"
        ? "dark"
        : "light";
  const appliedTheme =
    saved === "system"
      ? resolved === "dark"
        ? "zai-dark"
        : "zai-light"
      : saved === "dark"
        ? "zai-dark"
        : saved === "light"
          ? "zai-light"
          : saved;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle("theme-zai-light", appliedTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", appliedTheme === "zai-dark");
}

function RelayMobileApp({ session }: { session: RelayMobileSessionHandle }) {
  const [services, setServices] = useState<IServiceAccessor | null>(null);
  useEffect(() => () => session.dispose(), [session]);
  return (
    <ZCodeIntlProvider
      {...(services
        ? {
            settingService: services.settingService,
            broadcastService: services.broadcastService,
          }
        : {})}
      preferSettingServiceLocale
    >
      <MobileShell
        session={session}
        platform={createWebPlatform()}
        onBridgeChange={(bridge) => setServices(bridge?.services ?? null)}
      />
    </ZCodeIntlProvider>
  );
}

export async function renderRelayMobilePage(root: ReactRoot): Promise<void> {
  document.title = "FreeCodeZ 远程控制";
  seedMobileTheme();
  const injected = readInjectedConfig();
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  const sid = params.get("sid")?.trim() || injected.sid?.trim() || "";
  const hash = params.get("hash")?.trim() || injected.hash?.trim() || "";
  const wsUrl = injected.wsUrl?.trim() || resolveDefaultWsUrl();
  const name = params.get("name")?.trim() || injected.name?.trim() || "FreeCodeZ";
  const appVersion =
    params.get("app_version")?.trim() || injected.appVersion?.trim() || "0";

  if (!sid || !hash) {
    root.render(
      <AppErrorBoundary>
        <div className="flex h-dvh items-center justify-center bg-background text-ui-sm text-destructive">
          invalid mobile connection: missing sid/hash
        </div>
      </AppErrorBoundary>,
    );
    return;
  }

  const session = createRelayMobileSession({ wsUrl, sid, hash, name, appVersion });
  root.render(
    <AppErrorBoundary>
      <RelayMobileApp session={session} />
    </AppErrorBoundary>,
  );
}

export type { RelayMobileSessionHandle };
