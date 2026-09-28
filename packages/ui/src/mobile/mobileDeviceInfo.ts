import type { MobileDeviceInfo } from "@zcode/shared/web-remote-control";

// 手机侧 MobileDeviceInfo 构造（附录A §2 rb）：浏览器导航/视口/屏幕/时区快照。
// 独立成纯构造器便于注入与单测；name/version 由会话层（URL 的 name&app_version）覆盖。

export function buildMobileDeviceInfo(now: number = Date.now()): MobileDeviceInfo {
  const nav = globalThis.navigator as Navigator & { platform?: string };
  const viewport = globalThis.window?.innerWidth
    ? {
        width: globalThis.window.innerWidth,
        height: globalThis.window.innerHeight,
        devicePixelRatio: globalThis.window.devicePixelRatio || 1,
      }
    : undefined;
  const screenInfo = globalThis.screen?.width
    ? { width: globalThis.screen.width, height: globalThis.screen.height }
    : undefined;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    platform: nav?.platform || "mobile",
    version: "0",
    name: "mobile-web",
    ...(nav?.userAgent ? { userAgent: nav.userAgent } : {}),
    ...(nav?.language ? { language: nav.language } : {}),
    ...(Array.isArray(nav?.languages) ? { languages: Array.from(nav.languages) } : {}),
    ...(nav?.platform ? { browserPlatform: nav.platform } : {}),
    ...(viewport ? { viewport } : {}),
    ...(screenInfo ? { screen: screenInfo } : {}),
    ...(timezone ? { timezone } : {}),
    ...(typeof nav?.onLine === "boolean" ? { online: nav.onLine } : {}),
    updatedAt: now,
  };
}
