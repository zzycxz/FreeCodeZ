import { randomUUID } from "node:crypto";
import type { Protocol } from "electron";
import {
  PLUGIN_SANDBOX_MAX_INSTANCES,
  PLUGIN_SANDBOX_SCHEME,
  buildPluginSandboxContentCsp,
  isAllowedPluginSandboxOrigin,
  parsePluginSandboxUrl,
  pluginSandboxAppIdentity,
  pluginSandboxPartitionFor,
  pluginSandboxRegisterRequestSchema,
  pluginSandboxShellUrl,
  type PluginSandboxPermission,
  type PluginSandboxRegisterRequest,
} from "@zcode/shared";

// ============================================================
// U3-0（移植自 ZCode 3.15.1 plugin-sandbox 基座，上游 main 侧结构对照）：
// zcode-sandbox: 特权协议 + per-app 持久分区 + registry（内容源白名单）+ 并发配额
// + webview attach 分流判定。运行时项（真实 MCP App 打通）标注于 spec §U3-0。
// ============================================================

export class PluginSandboxQuotaError extends Error {
  constructor(limit: number) {
    super(`Plugin sandbox instance limit reached (${limit})`);
    this.name = "PluginSandboxQuotaError";
  }
}

export interface PluginSandboxAppRegistration {
  readonly appIdentity: string;
  readonly partition: string;
  readonly contentKind: PluginSandboxRegisterRequest["contentKind"];
  readonly origin: string | undefined;
  readonly permissions: readonly PluginSandboxPermission[];
}

export interface PluginSandboxInstance {
  readonly sandboxId: string;
  readonly appIdentity: string;
  readonly shellUrl: string;
}

export interface PluginSandboxGatewayDeps {
  protocol: Protocol;
  /** 内容重发布的拉取实现（默认全局 fetch；测试注入）。 */
  fetchImpl?: typeof fetch;
  logger: { warn: (...args: unknown[]) => void };
}

interface ShellRenderInput {
  pluginSrc: string;
  iframeAllow: string;
  /** 不可信载荷（插件回传用）；随 init 注入内层桥。 */
  initJson: string;
}

/** shell 文档（上游 shell chunk 同职责的 inline 形态）：内层 sandboxed iframe + 定向中继。 */
export function buildShellDocument(input: ShellRenderInput): string {
  const safeSrc = JSON.stringify(input.pluginSrc);
  const safeInit = JSON.stringify(input.initJson);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
  iframe { border: 0; width: 100%; height: 100%; display: block; }
</style>
</head>
<body>
<iframe id="plugin-frame" sandbox="allow-scripts allow-same-origin allow-forms" allow="${input.iframeAllow}" referrerpolicy="no-referrer"></iframe>
<script>
(function () {
  var init = ${safeInit};
  var frame = document.getElementById("plugin-frame");
  frame.src = ${safeSrc};
  // 定向中继：仅接受内层 frame 的消息，仅转发给同源 preload 桥；方向相反同理。
  window.addEventListener("message", function (event) {
    if (event.source !== frame.contentWindow) return;
    if (window.pluginSandboxBridge) {
      window.pluginSandboxBridge.hostMessage({ direction: "plugin-to-host", payload: event.data });
    }
  });
  if (window.pluginSandboxBridge) {
    window.pluginSandboxBridge.onHostMessage(function (payload) {
      frame.contentWindow.postMessage(payload, "*");
    });
    window.pluginSandboxBridge.hostMessage({ direction: "shell-init", payload: init });
  }
})();
</script>
</body>
</html>`;
}

/** Electron 要求 privileged scheme 在 app ready 前注册（localMediaPreview 同款先例）。 */
export function registerPluginSandboxScheme(protocol: Protocol): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_SANDBOX_SCHEME,
      privileges: { standard: true, secure: true },
    },
  ]);
}

export function createPluginSandboxGateway(deps: PluginSandboxGatewayDeps): {
  registerApp: (request: PluginSandboxRegisterRequest) => PluginSandboxAppRegistration;
  releaseApp: (appIdentity: string) => void;
  openInstance: (appIdentity: string) => PluginSandboxInstance;
  closeInstance: (sandboxId: string) => void;
  isRegisteredSandboxSrc: (src: string | undefined) => boolean;
  install: () => void;
} {
  const apps = new Map<string, PluginSandboxAppRegistration>();
  const appsByHash = new Map<string, PluginSandboxAppRegistration>();
  const instances = new Map<string, string>();
  const fetchImpl = deps.fetchImpl ?? fetch;

/** 身份短哈希（16 位）：与 shared pluginSandboxShellUrl 的派生口径一致（纯 JS，见 shared 模块注释）。 */
function hashIdentity(input: string): string {
  let h1 = 0xcbf29ce484222325n;
  let h2 = 0x84222325cbf29ce4n;
  for (let i = 0; i < input.length; i += 1) {
    const byte = BigInt(input.charCodeAt(i) & 0xff);
    h1 ^= byte;
    h1 = (h1 * 0x100000001b3n) & 0xffffffffffffffffn;
    h2 = (h2 + byte + h1) | 0n;
    h2 = (h2 * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return (h1.toString(16).padStart(16, "0") + h2.toString(16).padStart(16, "0")).slice(0, 16);
}

  function registerApp(request: PluginSandboxRegisterRequest): PluginSandboxAppRegistration {
    const parsed = pluginSandboxRegisterRequestSchema.parse(request);
    if (parsed.origin !== undefined && !isAllowedPluginSandboxOrigin(parsed.origin)) {
      throw new Error(`Plugin sandbox origin not allowed: ${parsed.origin}`);
    }
    const appIdentity = pluginSandboxAppIdentity(parsed);
    const existing = apps.get(appIdentity);
    if (existing) return existing;
    const registration: PluginSandboxAppRegistration = {
      appIdentity,
      partition: pluginSandboxPartitionFor(appIdentity),
      contentKind: parsed.contentKind,
      origin: parsed.origin,
      permissions: parsed.permissions ?? [],
    };
    apps.set(appIdentity, registration);
    appsByHash.set(hashIdentity(appIdentity), registration);
    return registration;
  }

  function openInstance(appIdentity: string): PluginSandboxInstance {
    if (!apps.has(appIdentity)) throw new Error(`Plugin sandbox app not registered: ${appIdentity}`);
    if (instances.size >= PLUGIN_SANDBOX_MAX_INSTANCES) {
      throw new PluginSandboxQuotaError(PLUGIN_SANDBOX_MAX_INSTANCES);
    }
    const sandboxId = randomUUID();
    instances.set(sandboxId, appIdentity);
    return { sandboxId, appIdentity, shellUrl: pluginSandboxShellUrl(appIdentity, sandboxId) };
  }

  function closeInstance(sandboxId: string): void {
    instances.delete(sandboxId);
  }

  function appForUrlParts(parts: { role: string; appIdentityHash: string }): PluginSandboxAppRegistration | undefined {
    return appsByHash.get(parts.appIdentityHash);
  }

  function isRegisteredSandboxSrc(src: string | undefined): boolean {
    if (src === undefined || !src.startsWith(`${PLUGIN_SANDBOX_SCHEME}://`)) return false;
    const parts = parsePluginSandboxUrl(src);
    if (parts === undefined) return false;
    return appsByHash.has(parts.appIdentityHash);
  }

  async function servePluginContent(
    app: PluginSandboxAppRegistration,
    contentPath: string,
  ): Promise<Response> {
    if (app.origin === undefined) {
      return new Response("plugin origin unavailable", { status: 404 });
    }
    const target = `${app.origin}${contentPath}`;
    let fetched: Response;
    try {
      fetched = await fetchImpl(target, { headers: { accept: "text/html,*/*" } });
    } catch (error) {
      deps.logger.warn("[plugin-sandbox] content fetch failed", { target, error });
      return new Response("upstream fetch failed", { status: 502 });
    }
    const headers = new Headers({
      "content-type": fetched.headers.get("content-type") ?? "text/html; charset=utf-8",
      "content-security-policy": buildPluginSandboxContentCsp(),
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    // 凭据不透传：重发布剥 cookie/authorization（fetch 默认 same-origin 不带跨源凭据，
    // 这里显式丢弃上游响应里的 Set-Cookie 头——headers 重建即剥除）。
    return new Response(await fetched.arrayBuffer(), { status: fetched.status, headers });
  }

  function install(): void {
    deps.protocol.handle(PLUGIN_SANDBOX_SCHEME, (request) => {
      const parts = parsePluginSandboxUrl(request.url);
      if (parts === undefined) {
        return new Response("invalid sandbox url", { status: 400 });
      }
      const app = appForUrlParts(parts);
      if (app === undefined || parts.sandboxId === "" || !instances.has(parts.sandboxId)) {
        return new Response("sandbox instance not found", { status: 404 });
      }
      if (parts.role === "shell") {
        const pluginPath = app.origin === undefined ? undefined : "/index.html";
        const pluginSrc =
          app.origin === undefined || pluginPath === undefined
            ? "about:blank"
            : `${PLUGIN_SANDBOX_SCHEME}://plugin-${parts.appIdentityHash}/instance/${parts.sandboxId}${pluginPath}`;
        const iframeAllow =
          app.permissions.length > 0
            ? app.permissions.map((permission) => `${permission}`).join("; ")
            : "";
        return new Response(
          buildShellDocument({ pluginSrc, iframeAllow, initJson: JSON.stringify({ sandboxId: parts.sandboxId }) }),
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
            },
          },
        );
      }
      return servePluginContent(app, parts.contentPath);
    });
  }

  return { registerApp, releaseApp: (appIdentity) => { apps.delete(appIdentity); }, openInstance, closeInstance, isRegisteredSandboxSrc, install };
}


// U3-0：模块级默认网关（chrome will-attach 在窗口装配期即需查询；实例未初始化时视为未注册）。
let defaultGateway: ReturnType<typeof createPluginSandboxGateway> | undefined;

export function setDefaultPluginSandboxGateway(gateway: ReturnType<typeof createPluginSandboxGateway>): void {
  defaultGateway = gateway;
}

export function isRegisteredPluginSandboxSrc(src: string | undefined): boolean {
  return defaultGateway?.isRegisteredSandboxSrc(src) === true;
}
