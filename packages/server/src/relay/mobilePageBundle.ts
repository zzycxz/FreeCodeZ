import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { renderMobilePage, type MobilePageConfig as RelayMobilePageConfig } from "./mobilePage.js";

// /remote/v4 的移动页 bundle 服务（spec W1：自建 relay 托管手机页）：
//   1) ZCODE_WEB_REMOTE_MOBILE_PAGE_PROXY 指向 dev 服务器（需以 --base /remote/v4/ 启动）→ 转发并注入 __RELAY_CONFIG__；
//   2) ZCODE_WEB_REMOTE_MOBILE_PAGE_DIR（缺省 packages/web/dist-mobile）→ 静态服务 + 注入 __RELAY_CONFIG__；
//   3) 都不可用 → 调用方退回 mobilePage.ts 内嵌最小页（保留为 fallback）。
// bundle 由 scripts/build-web-remote-mobile-page.mjs 产出（复用 packages/web 的 vite 链，独立 outDir/base）。

export interface MobilePageConfig {
  sid: string;
  hash: string;
  wsUrl: string;
  t?: string;
  mid?: string;
  name?: string;
  appVersion?: string;
}

export interface MobilePageAsset {
  status: number;
  contentType: string;
  body: string | Uint8Array;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** bundle 目录解析：env 覆盖 > 源码布局（packages/server/src/relay → packages/web/dist-mobile）> 构建布局。 */
export function resolveMobilePageDir(env?: Record<string, string | undefined>): string {
  const override = env?.["ZCODE_WEB_REMOTE_MOBILE_PAGE_DIR"]?.trim();
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "web", "dist-mobile");
}

export function resolveMobilePageProxyOrigin(
  env?: Record<string, string | undefined>,
): string | undefined {
  const value = env?.["ZCODE_WEB_REMOTE_MOBILE_PAGE_PROXY"]?.trim();
  return value ? value.replace(/\/+$/u, "") : undefined;
}

function escapeJsonForScript(value: unknown): string {
  // JSON 内联进 <script>：转义 "<" 防止提前闭合脚本标签（与 mobilePage.ts 同规则）。
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** 给 HTML 注入 __RELAY_CONFIG__（缺 <head> 时插到最前，保证页面首帧就能读到配对参数）。 */
export function injectRelayConfig(html: string, config: MobilePageConfig): string {
  const script = `<script>window.__RELAY_CONFIG__ = ${escapeJsonForScript(config)};</script>`;
  const headIndex = html.search(/<head[^>]*>/iu);
  if (headIndex >= 0) {
    const insertAt = html.indexOf(">", headIndex) + 1;
    return `${html.slice(0, insertAt)}${script}${html.slice(insertAt)}`;
  }
  return `${script}${html}`;
}

/** '/remote/v4' 前缀的静态路由 → bundle 内文件；防目录穿越，越界返回 null。 */
export async function readMobilePageAsset(
  dir: string,
  pathname: string,
): Promise<MobilePageAsset | null> {
  const prefix = "/remote/v4";
  let relative: string;
  if (pathname === prefix || pathname === `${prefix}/`) {
    relative = "index.html";
  } else if (pathname.startsWith(`${prefix}/`)) {
    relative = pathname.slice(prefix.length + 1);
  } else {
    return null;
  }
  const root = resolve(dir);
  const filePath = resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(root + sep)) return null;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    // HTML 以 utf8 文本读出（随后要注入 __RELAY_CONFIG__）；其余按二进制。
    const body =
      extname(filePath).toLowerCase() === ".html"
        ? await readFile(filePath, "utf8")
        : await readFile(filePath);
    return { status: 200, contentType: contentTypeFor(filePath), body };
  } catch {
    return null;
  }
}

/** dev 转发：原样请求 dev 服务器同路径（需 --base /remote/v4/），HTML 额外注入 __RELAY_CONFIG__。 */
export async function proxyMobilePage(
  proxyOrigin: string,
  url: URL,
  config: MobilePageConfig,
): Promise<MobilePageAsset | null> {
  const target = `${proxyOrigin}${url.pathname}${url.search}`;
  try {
    const response = await fetch(target, {
      headers: { accept: "*/*" },
      redirect: "manual",
    });
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (contentType.includes("text/html")) {
      const html = await response.text();
      return { status: response.status, contentType, body: injectRelayConfig(html, config) };
    }
    const body = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, contentType, body };
  } catch {
    return null;
  }
}

export function isHtmlAsset(asset: MobilePageAsset): boolean {
  return asset.contentType.includes("text/html");
}

function trimParam(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** 配对 URL 查询参数 → 页面注入配置（/remote/v4?sid&hash&t&mid&name&app_version）。 */
export function buildMobilePageConfig(url: URL, wsUrl: string): MobilePageConfig {
  return {
    sid: trimParam(url.searchParams.get("sid")) ?? "",
    hash: trimParam(url.searchParams.get("hash")) ?? "",
    wsUrl,
    ...(trimParam(url.searchParams.get("t")) ? { t: trimParam(url.searchParams.get("t")) } : {}),
    ...(trimParam(url.searchParams.get("mid"))
      ? { mid: trimParam(url.searchParams.get("mid")) }
      : {}),
    ...(trimParam(url.searchParams.get("name"))
      ? { name: trimParam(url.searchParams.get("name")) }
      : {}),
    ...(trimParam(url.searchParams.get("app_version"))
      ? { appVersion: trimParam(url.searchParams.get("app_version")) }
      : {}),
  };
}

/** hono 的 Data 要求 Uint8Array<ArrayBuffer>；Buffer 视图在这里复制成独立视图。 */
function assetBodyForResponse(asset: MobilePageAsset): string | Uint8Array<ArrayBuffer> {
  return typeof asset.body === "string" ? asset.body : Uint8Array.from(asset.body);
}

/**
 * /remote/v4 路由注册：dev 转发 → bundle 静态服务（注入 __RELAY_CONFIG__）→ 内嵌最小页 fallback。
 * bundle 目录缺省 packages/web/dist-mobile（scripts/build-web-remote-mobile-page.mjs 产出）。
 */
export function registerMobilePageRoutes(
  app: Hono,
  options: { mobilePageDir?: string; mobilePageProxyOrigin?: string } = {},
): void {
  const mobilePageDir = options.mobilePageDir ?? resolveMobilePageDir(process.env);
  const mobilePageProxyOrigin =
    options.mobilePageProxyOrigin ?? resolveMobilePageProxyOrigin(process.env);

  function buildConfig(url: URL): RelayMobilePageConfig {
    const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
    return buildMobilePageConfig(url, `${wsProtocol}//${url.host}/ws`);
  }

  async function resolveMobileAsset(
    url: URL,
    config: MobilePageConfig,
  ): Promise<MobilePageAsset | null> {
    if (mobilePageProxyOrigin) {
      const proxied = await proxyMobilePage(mobilePageProxyOrigin, url, config);
      if (proxied) return proxied;
    }
    const asset = await readMobilePageAsset(mobilePageDir, url.pathname);
    if (asset && isHtmlAsset(asset) && typeof asset.body === "string") {
      return { ...asset, body: injectRelayConfig(asset.body, config) };
    }
    return asset;
  }

  app.get("/remote/v4", async (c) => {
    const url = new URL(c.req.url);
    const config = buildConfig(url);
    const asset = await resolveMobileAsset(url, config);
    if (asset) {
      return c.body(assetBodyForResponse(asset), 200, { "Content-Type": asset.contentType });
    }
    // bundle 不可用时保留最小页（手机握手契约验证用），保证 /remote/v4 始终有响应。
    return c.html(renderMobilePage(config));
  });

  app.get("/remote/v4/*", async (c) => {
    const url = new URL(c.req.url);
    const asset = await resolveMobileAsset(url, buildConfig(url));
    if (!asset) return c.text("mobile page asset not found", 404);
    return c.body(assetBodyForResponse(asset), 200, { "Content-Type": asset.contentType });
  });
}
