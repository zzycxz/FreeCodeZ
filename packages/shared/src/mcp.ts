/**
 * MCP (Model Context Protocol) types for ZCode
 * Based on the original Tauri implementation
 */

import type { SettingsDirectoryLocation } from "./settings-source.js";
import type { McpServerFailureKind } from "./zcode-protocol/index.js";
import { estimateTokensFromText } from "./token-estimate.js";

// CUA official plugin 身份常量（port 自 feat；UI 设置面板 + bootstrap 复用以避免字面量漂移）。
export const ZCODE_CUA_OFFICIAL_PLUGIN_ID = "computer-use@zcode-plugins-official";
// CUA server 身份串（port 自 feat mcp.ts）：server key = 模型可见工具前缀段（刻意不带 zcode-）；
// namespace name = official plugin 运行时命名空间 plugin:<pluginId>:<serverKey>。
export const ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME = "plugin:computer-use:computer-use";
// 插件身份 env key：resolver（adapters/src/plugins/mcp.ts）权威写入 loaded.id，manifest/user env 不可覆盖。
// bootstrap + cli/plugin-host-command.ts 复用此常量识别 official zcode-cua plugin server，避免字面量漂移。
export const ZCODE_PLUGIN_ID_ENV_KEY = "FREECODEZ_PLUGIN_ID";

export type McpSource = "mcp" | "zcodeagentmcp";
export type CliMcpSource = Exclude<McpSource, "mcp">;
export type McpScope = "common" | "user" | "workspace";
export type McpFileFormat = "json";

// Single MCP server configuration
export interface McpServerConfig {
  type?: string; // Supports stdio, http, sse, streamableHttp, etc.
  url?: string; // HTTP/SSE server URL
  command?: string; // stdio server command
  args?: string[]; // stdio server arguments
  env?: Record<string, string>; // stdio server environment variables
  headers?: Record<string, string>; // HTTP/SSE server request headers
  http_headers?: Record<string, string>; // 兼容旧配置字段，历史 BigModel MCP 配置会把鉴权头写在这里
  oauth?: McpOAuthConfig; // HTTP/SSE OAuth 机器凭据配置
  // 工具级开关（denylist 语义，spec docs/spec/mcp-availability-first-cost-management.md 规则 2.1）：
  // 缺省/空 = 全放行；命中名单的工具不进模型 tools 装配。server 后续新增工具一律默认放行。
  // 该字段不参与连接收敛的相等性比较（拨开关不得触发断连重连）。
  disabledTools?: string[];
  /**
   * 条目 8（spec §12）：per-server 工具曝光档。缺省 "full"（R1 默认全量）。
   * "deferred" = 目录态（名称+描述进目录、schema 按需展开）；仅当全局
   * features.mcpDeferredTools 开启时生效（双门，A/B 对照通过前默认关）。
   */
  toolExposure?: "full" | "deferred";
  /**
   * 条目 8（spec §12）：env 白名单——在场时仅名单内的 env 键下发给 stdio server
   * 子进程；缺省全部下发（R1 默认不变）。用户显式设置才收窄；拼写错误的名字
   * 会被连接警告提示（fail-visible，不静默丢变量）。
   */
  envAllowlist?: string[];
  // Linear specific fields
  apiKey?: string;
  projectId?: string;
  issueType?: string;
  // Figma specific fields
  personalAccessToken?: string;
  fileId?: string;
  nodeId?: string;
  // Sentry specific fields
  organizationName?: string;
  projectName?: string;
  dsn?: string;
  // Context7 specific fields
  apiEndpoint?: string;
  [key: string]: any;
}

export type McpServerStatus = "connected" | "disconnected" | "error" | "connecting" | "unknown";

export interface CliMcpConfig {
  mcpServers: Record<string, McpServerConfig>;
  projects: Record<string, Record<string, McpServerConfig>>;
}

export interface SaveCliMcpToUserDirectoryRequest {
  action: "upsert" | "delete" | "set-enabled";
  source: CliMcpSource;
  name: string;
  config?: McpServerConfig;
  enabled?: boolean;
  projectPath?: string;
  location?: SettingsDirectoryLocation;
}

export interface NativeMcpFileReference {
  format: McpFileFormat;
  filePath: string;
}

export interface NativeMcpServerRecord {
  source: McpSource;
  scope: McpScope;
  name: string;
  config: McpServerConfig;
  enabled?: boolean;
  projectPath?: string;
  location?: SettingsDirectoryLocation;
  file?: NativeMcpFileReference;
}

export interface LoadCliMcpFromUserDirectoryRequest {
  workspacePath?: string;
}

export interface LoadCliMcpFromUserDirectoryResult {
  servers: NativeMcpServerRecord[];
}

export interface MigrateLegacyCommonMcpRequest {
  legacyStorageDir?: string;
}

export interface MigrateLegacyCommonMcpResult {
  servers: Record<string, McpServerConfig>;
  sourcePath?: string;
  /** 旧数据中发现的 MCP 配置总数 */
  totalCount: number;
  /** 成功导入的数量 */
  importedCount: number;
  /** 因已存在而跳过的数量 */
  skippedCount: number;
}

export interface McpConfig {
  mcp: {
    mcpServers: Record<string, McpServerConfig>;
  };
  zcodeagentmcp: CliMcpConfig;
}

export interface ZCodeMcpServer {
  id: string;
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  changed?: boolean;
  status?: McpServerStatus;
  lastConnected?: Date;
  error?: string;
  failureKind?: McpServerFailureKind;
  serverRequestId?: string;
  toolCount?: number;
  authorization?: {
    type: "oauth_authorization_code";
    authorizationUrl: string;
    startedAt: string;
  };
  source: McpSource;
  projectPath?: string;
  scope: McpScope;
  location?: SettingsDirectoryLocation;
  file?: NativeMcpFileReference;
}

export interface McpServerListItem {
  id: string;
  name: string;
  enabled: boolean;
  status: McpServerStatus;
  hasConfig: boolean;
  error?: string;
  toolCount?: number;
  source: McpSource;
  projectPath?: string;
  scope: McpScope;
  file?: NativeMcpFileReference;
}

export interface McpTestResult {
  success: boolean;
  error?: string;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema?: any;
  }>;
  serverInfo?: {
    name: string;
    version: string;
  };
  response_time?: number;
}

export type ZCodeAgentMcpServer =
  | {
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
      isolation?: "session" | "workspace";
      protocolVersion?: "legacy" | "auto" | "2026-07-28";
      timeoutMs?: number;
    }
  | {
      name: string;
      type: "http" | "sse";
      url: string;
      isolation?: "session" | "workspace";
      protocolVersion?: "legacy" | "auto" | "2026-07-28";
      headers: Array<{ name: string; value: string }>;
      oauth?: McpOAuthConfig;
      timeoutMs?: number;
    };

export interface McpClientCredentialsOAuthConfig {
  type: "client_credentials";
  clientId: string;
  clientSecret: string;
  clientName?: string;
  scope?: string;
}

export interface McpAuthorizationCodeOAuthConfig {
  type: "authorization_code";
  clientId?: string;
  clientSecret?: string;
  clientName?: string;
  redirectPath?: string;
  scope?: string;
}

export type McpOAuthConfig = McpAuthorizationCodeOAuthConfig | McpClientCredentialsOAuthConfig;

export function getMcpServerRequestHeaders(
  config: McpServerConfig,
): Record<string, string> | undefined {
  return config.headers ?? config.http_headers;
}

// zcode-cua MCP server 识别的单一事实源。desktop 产品 broker resolver（@zcode/services 的
// mcpBrokerInjection）与 CLI bootstrap（apps/zcode-cli 的 mcp-config）两条注入入口必须用
// 完全一致的判定；否则同一 MCP 配置在不同入口行为不同，可能漏注入 product broker，让
// Python/uvx 自己持有 macOS TCC 权限（违反 fail-closed 边界）。改这里即同时改两条链路。
function zcodeCuaArgLeaf(value: string): string {
  // 先去掉结尾的路径分隔符再取叶子：`.../zcode-cua/` 直接 split 会得到空串叶子 → 漏判 → fail-open。
  return (
    value
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? value
  );
}

// 单个候选串是否为 zcode-cua 的包规格。PyPI 视 `_`/`-` 等价，故先把下划线归一成短横（zcode_cua →
// zcode-cua）；覆盖 uv/npm 的 `@version`、pip 的 `==version`、extras `[...]`、git 的 `.git`/`.git@`，
// 以及 `python -m zcode_cua.server` 这种点号子模块（`zcode-cua.<submodule>`）。fail-closed 边界宁可
// 过判也不漏判；仍不会误判 `zcode-cua-proxy`（短横续接，不以 `.`/`@`/`[`/`==` 边界续接）。
function matchesZCodeCuaSpec(candidate: string): boolean {
  const c = candidate.replace(/_/g, "-");
  return (
    c === "zcode-cua" ||
    c.startsWith("zcode-cua[") ||
    c.startsWith("zcode-cua@") ||
    c.startsWith("zcode-cua==") ||
    // `.` 分支同时覆盖 `zcode-cua.git` / `zcode-cua.git@v1` 与 `zcode-cua.server` 等 python 子模块。
    c.startsWith("zcode-cua.")
  );
}

/**
 * MCP server 的 command 是否指向 zcode-cua。用与 args 相同的包规格判定（并比对路径叶子），
 * 覆盖 `command: "zcode-cua"`、`/opt/bin/zcode-cua`，以及把包规格直接当 command 的写法
 * （`zcode-cua@1.2.3` 等）。对 fail-closed 边界宁可过判也不漏判。
 */
export function isZCodeCuaMcpCommand(command: string): boolean {
  return matchesZCodeCuaSpec(command) || matchesZCodeCuaSpec(zcodeCuaArgLeaf(command));
}

/**
 * 单个 arg 是否为 zcode-cua 的包规格。覆盖 `zcode-cua`、`zcode-cua[macos]`、`zcode-cua@1.2.3`、
 * `zcode-cua==1.2.3`、`zcode_cua`，以及 git / 本地路径形态（`.../zcode-cua`、`zcode-cua.git`、
 * `git+https://.../zcode-cua.git@v1`）。同时比对原始值与路径叶子，覆盖 `--from <path>`、`--from <git-url>`。
 */
export function isZCodeCuaMcpPackageArg(value: string): boolean {
  return matchesZCodeCuaSpec(value) || matchesZCodeCuaSpec(zcodeCuaArgLeaf(value));
}

export function convertToZCodeAgentMcpServer(
  name: string,
  config: McpServerConfig,
): ZCodeAgentMcpServer | null {
  let inferredType = config.type;
  if (!inferredType) {
    if (config.command) inferredType = "stdio";
    else if (config.url) inferredType = "http";
  }

  const isStdio = inferredType === "stdio";
  if (isStdio && config.command) {
    // Windows 上 agent 通常用 shell: true 启动子进程，
    // "cmd /c npx ..." 会被双重包裹成 "cmd.exe /c cmd /c npx ..." 导致连接失败。
    // 这里把 cmd /c 包衣拆掉，直接使用内部命令。
    let command = config.command;
    let args = config.args || [];
    // 自动检测平台：Node.js 用 process.platform，浏览器用 navigator.platform
    const isWin32 =
      (typeof process !== "undefined" && process.platform === "win32") ||
      (typeof navigator !== "undefined" && /win/i.test(navigator.platform));
    if (isWin32) {
      const lowerCmd = command.toLowerCase();
      const unwrappedCommand = args[1];
      if ((lowerCmd === "cmd" || lowerCmd === "cmd.exe") && args[0] === "/c" && unwrappedCommand) {
        // noUncheckedIndexedAccess 下 args[1] 即使经过 length 判断也仍是 string | undefined。
        // 先显式取值并判空，既满足类型收窄，也避免把空命令传给 ZCode Agent。
        command = unwrappedCommand;
        args = args.slice(2);
      }
    }
    return {
      name,
      command,
      args,
      env: config.env
        ? Object.entries(config.env).map(([key, value]) => ({
            name: key,
            value,
          }))
        : [],
      // MCP 设置页会把 timeoutMs 写入 config；session/create 走协议 DTO 时
      // 只能透传正整数，否则 strict protocol schema 会把存量非法配置从“忽略”变成“创建失败”。
      ...(isValidMcpTimeoutMs(config.timeoutMs) ? { timeoutMs: config.timeoutMs } : {}),
      ...(isMcpIsolation(config.isolation) ? { isolation: config.isolation } : {}),
      ...(isMcpProtocolVersion(config.protocolVersion)
        ? { protocolVersion: config.protocolVersion }
        : {}),
    };
  } else if (config.url && inferredType) {
    const normalizedType: "http" | "sse" = inferredType === "sse" ? "sse" : "http";
    const headers = getMcpServerRequestHeaders(config);
    return {
      name,
      type: normalizedType,
      url: config.url,
      headers: headers
        ? Object.entries(headers).map(([key, value]) => ({
            name: key,
            value,
          }))
        : [],
      ...(isValidMcpOAuthConfig(config.oauth) ? { oauth: config.oauth } : {}),
      // HTTP/SSE MCP 与 stdio 一样需要保留超时配置，避免 UI 保存后真实 session 丢字段。
      ...(isValidMcpTimeoutMs(config.timeoutMs) ? { timeoutMs: config.timeoutMs } : {}),
      ...(isMcpIsolation(config.isolation) ? { isolation: config.isolation } : {}),
      ...(isMcpProtocolVersion(config.protocolVersion)
        ? { protocolVersion: config.protocolVersion }
        : {}),
    };
  }
  return null;
}

function isValidMcpTimeoutMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isMcpIsolation(value: unknown): value is "session" | "workspace" {
  return value === "session" || value === "workspace";
}

function isMcpProtocolVersion(value: unknown): value is "legacy" | "auto" | "2026-07-28" {
  return value === "legacy" || value === "auto" || value === "2026-07-28";
}

function isValidMcpOAuthConfig(value: unknown): value is McpOAuthConfig {
  if (!isRecord(value)) return false;
  if (
    value.type === "client_credentials" &&
    typeof value.clientId === "string" &&
    value.clientId.trim().length > 0 &&
    typeof value.clientSecret === "string" &&
    value.clientSecret.trim().length > 0
  ) {
    return (
      (value.clientName === undefined || typeof value.clientName === "string") &&
      (value.scope === undefined || typeof value.scope === "string")
    );
  }
  if (value.type === "authorization_code") {
    return (
      (value.clientId === undefined || typeof value.clientId === "string") &&
      (value.clientSecret === undefined || typeof value.clientSecret === "string") &&
      (value.clientName === undefined || typeof value.clientName === "string") &&
      (value.redirectPath === undefined || typeof value.redirectPath === "string") &&
      (value.scope === undefined || typeof value.scope === "string")
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ============================================================
// MCP 工具可见性 / 成本观测（spec: mcp-availability-first-cost-management）
// 全部为纯函数；判定依据只来自服务端显式声明，缺省一律放行（红线 R1/R4）。
// ============================================================

/** 工具 schema 序列化超过该字节数时 UI 标注「schema 偏大」；仅提示，不截断（红线 R3）。 */
export const MCP_TOOL_SCHEMA_LARGE_BYTES = 4096;

/**
 * MCP Apps 规范的工具可见性判定（codex tool_is_model_visible 同义）：
 * `_meta.ui.visibility` 为数组且不含 "model" 时该工具不对模型暴露；
 * 无 `_meta`、字段缺失或形态异常一律放行——服务端不声明就不隐藏。
 */
export function mcpToolModelVisible(meta: unknown): boolean {
  if (!isRecord(meta)) return true;
  const ui = meta.ui;
  if (!isRecord(ui)) return true;
  const visibility = ui.visibility;
  if (!Array.isArray(visibility)) return true;
  return visibility.some((target) => target === "model");
}

/**
 * 条目 8（升级实施手册，spec §12）：工具曝光三态。
 *   "full"     schema 完整注入（R1 默认）；
 *   "deferred" 目录态——名称+描述进目录、schema 按需展开（spec §12 例外通道；
 *              仅用户显式 toolExposure:"deferred" + features.mcpDeferredTools 双门开时由装配层采用）；
 *   "hidden"   不可见（用户关闭 / 协议 visibility 显式排除——R4 前两类）。
 * 本函数只做**协议侧事实判定**（visibility），用户配置与全局门在装配层合成——
 * 单一事实源不混层。
 */
export type McpToolExposure = "full" | "deferred" | "hidden";

export function mcpToolExposure(meta: unknown): McpToolExposure {
  return mcpToolModelVisible(meta) ? "full" : "hidden";
}

export interface McpToolTokenEstimateInput {
  name: string;
  description?: string | null;
  /** 原始 JSON Schema（未知形态时按空对象计）。 */
  inputSchema?: unknown;
}

/**
 * 单工具上下文成本估算（token）。B1 起口径统一为 token-estimate 的全仓唯一实现
 * （CJK 按 3 个估算字符计、总和 ÷4）。schema 以 JSON 序列化长度参与估算。
 */
export function estimateMcpToolTokens(input: McpToolTokenEstimateInput): number {
  const schemaText = input.inputSchema === undefined ? "" : safeJsonText(input.inputSchema);
  return estimateTokensFromText(`${input.name}\n${input.description ?? ""}\n${schemaText}`);
}

/** 单工具 inputSchema 的 JSON 序列化字节数（UTF-16 code unit 数，UI「schema 偏大」标注用）。 */
export function mcpToolSchemaBytes(inputSchema: unknown): number {
  return inputSchema === undefined ? 0 : safeJsonText(inputSchema).length;
}

function safeJsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** UI 工具清单条目类型（ZCodeMcpToolSummary）以协议 schema 推导为准：
 * packages/shared/src/zcode-protocol/index.ts 的 zcodeMcpToolSummarySchema。 */

export function estimateMcpServerToolsTokens(tools: readonly McpToolTokenEstimateInput[]): number {
  return tools.reduce((total, tool) => total + estimateMcpToolTokens(tool), 0);
}

// 条目 9（升级实施手册）：resources/prompts 能力面类型投影（实现端口在 contracts McpPort）。
export type McpResourceDescriptor = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
};
export type McpResourceContent = {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
};
export type McpPromptDescriptor = {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
};
export type McpPromptMessage = {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
};
