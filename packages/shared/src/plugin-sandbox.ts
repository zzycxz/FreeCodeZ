import { z } from "zod";

// ============================================================
// U3-0（移植自 ZCode 3.15.1 plugin-sandbox 基座，上游 out/plugin-sandbox/ +
// preload/pluginSandbox.cjs 结构对照）：类型、provenance 校验、CSP、配额、
// 分区/URL 构造——全部纯件（main/renderer 两端共用）。
// ============================================================
// 安全不变量（不可降级，见 docs/spec/upstream-port-3.15.1-u3.md §U3-0）：
// 插件 UI = webview（专用 preload + 独立持久分区）内的 sandboxed iframe 双隔离；
// 内容经 main 从插件 origin 拉取后重发布到 zcode-sandbox: 特权协议（剥凭据+强 CSP）。

export const PLUGIN_SANDBOX_SCHEME = "zcode-sandbox";

/** 两种卡片来源（上游 contentKind）：Gen UI 无插件身份；MCP App 必须带 pluginId/serverName。 */
export const pluginSandboxContentKindSchema = z.enum(["gen-ui", "mcp-app"]);
export type PluginSandboxContentKind = z.infer<typeof pluginSandboxContentKindSchema>;

/** iframe allow 列表（上游按 permissions 过滤注入）。 */
export const PLUGIN_SANDBOX_IFRAME_ALLOW_PERMISSIONS = [
  "camera",
  "microphone",
  "geolocation",
  "clipboard-write",
] as const;
export type PluginSandboxIframeAllowPermission =
  (typeof PLUGIN_SANDBOX_IFRAME_ALLOW_PERMISSIONS)[number];

export const pluginSandboxPermissionSchema = z.enum(
  PLUGIN_SANDBOX_IFRAME_ALLOW_PERMISSIONS,
);
export type PluginSandboxPermission = z.infer<typeof pluginSandboxPermissionSchema>;

/**
 * 注册载荷 provenance（上游 register-request 的 refine 同款）：
 * gen-ui 不携带插件身份；mcp-app 必须携带 pluginId + serverName。
 */
export const pluginSandboxRegisterRequestSchema = z
  .object({
    contentKind: pluginSandboxContentKindSchema,
    pluginId: z.string().min(1).optional(),
    serverName: z.string().min(1).optional(),
    /** MCP App 的 UI 内容源（https/wss 或 127.0.0.1 loopback；此处仅做形态校验，白名单在 main）。 */
    origin: z.string().min(1).optional(),
    permissions: z.array(pluginSandboxPermissionSchema).optional(),
    /** 同 app 并发卡片的业务标识（去重复用实例）。 */
    appKey: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.contentKind === "mcp-app") {
      if (!value.pluginId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pluginId"], message: "required for mcp-app" });
      }
      if (!value.serverName) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["serverName"], message: "required for mcp-app" });
      }
      if (!value.origin) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["origin"], message: "required for mcp-app" });
      }
    }
  });
export type PluginSandboxRegisterRequest = z.infer<typeof pluginSandboxRegisterRequestSchema>;

/** 注册应答（上游 register-result 同形）。 */
export interface PluginSandboxRegisterResult {
  sandboxId: string;
  appIdentity: string;
  partition: string;
  shellUrl: string;
}

/** 并发卡片配额（上游 PluginSandboxQuotaError 对应上限）。 */
export const PLUGIN_SANDBOX_MAX_INSTANCES = 5;

/**
 * app 身份串：同身份共用分区与内容白名单（上游 appIdentity 语义——
 * gen-ui 按 appKey/路径区分，mcp-app 按 pluginId@serverName）。
 */
export function pluginSandboxAppIdentity(request: PluginSandboxRegisterRequest): string {
  return request.contentKind === "gen-ui"
    ? `gen-ui:${request.appKey ?? "default"}`
    : `mcp-app:${request.pluginId}@${request.serverName}`;
}

/** 纯 JS 64 位 FNV-1a（两轮展开为 32 hex）——分区名只需要稳定去标识，不需要密码学强度；
 *  不用 node:crypto 是因为本模块走 shared barrel，preload 白名单防线禁止 node: 原生导入
 *  （见 packages/shared test barrelPreloadHygiene）。
 */
function stableDigest(input: string): string {
  let h1 = 0xcbf29ce484222325n;
  let h2 = 0x84222325cbf29ce4n;
  for (let i = 0; i < input.length; i += 1) {
    const byte = BigInt(input.charCodeAt(i) & 0xff);
    h1 ^= byte;
    h1 = (h1 * 0x100000001b3n) & 0xffffffffffffffffn;
    h2 = (h2 + byte + h1) | 0n;
    h2 = (h2 * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return (h1.toString(16).padStart(16, "0") + h2.toString(16).padStart(16, "0")).slice(0, 32);
}

/** 持久分区名（上游 persist:plugin-sandbox-v2-<hash(appIdentity)> 同形）。 */
export function pluginSandboxPartitionFor(appIdentity: string): string {
  return `persist:plugin-sandbox-v2-${stableDigest(appIdentity)}`;
}

/** shell 页 URL：zcode-sandbox://shell-<appIdentityHash>/instance/<sandboxId>/ */
export function pluginSandboxShellUrl(appIdentity: string, sandboxId: string): string {
  const identityHash = stableDigest(appIdentity).slice(0, 16);
  return `${PLUGIN_SANDBOX_SCHEME}://shell-${identityHash}/instance/${sandboxId}/`;
}

export interface PluginSandboxUrlParts {
  role: "shell" | "plugin";
  appIdentityHash: string;
  sandboxId: string;
  /** plugin 角色的内容路径（以 / 开头）。 */
  contentPath: string;
}

/** 解析 zcode-sandbox: URL（非法返回 undefined）。 */
export function parsePluginSandboxUrl(rawUrl: string): PluginSandboxUrlParts | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${PLUGIN_SANDBOX_SCHEME}:`) return undefined;
  const host = parsed.hostname;
  const instanceMatch = new RegExp("^/instance/([_A-Za-z0-9-]+)(/.*)?$").exec(parsed.pathname);
  if (!instanceMatch) return undefined;
  const sandboxId = instanceMatch[1] ?? "";
  if (host.startsWith("shell-")) {
    return {
      role: "shell",
      appIdentityHash: host.slice("shell-".length),
      sandboxId,
      contentPath: parsed.pathname,
    };
  }
  if (host.startsWith("plugin-")) {
    const contentPath = instanceMatch[2] ?? "/";
    return {
      role: "plugin",
      appIdentityHash: host.slice("plugin-".length),
      sandboxId,
      contentPath,
    };
  }
  return undefined;
}

/** 内容源 origin 白名单形态：https/wss 或 127.0.0.1 loopback（上游同款）。 */
export function isAllowedPluginSandboxOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === "https:" || parsed.protocol === "wss:") return true;
    if (parsed.protocol === "http:" && parsed.hostname === "127.0.0.1") return true;
    return false;
  } catch {
    return false;
  }
}

/** 内容响应 CSP（上游强 CSP 同款；style 允许 inline——插件 UI 的普遍形态）。 */
export function buildPluginSandboxContentCsp(): string {
  return [
    "default-src 'none'",
    `frame-src ${PLUGIN_SANDBOX_SCHEME}:`,
    "script-src 'wasm-unsafe-eval'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "form-action 'none'",
  ].join("; ");
}
