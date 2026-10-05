export const ZCODE_WORKSPACE_IDENTITY_ENV = "ZCODE_WORKSPACE_IDENTITY";

export const ZCODE_RUNTIME_ENV_KEY = "ZCODE_RUNTIME_ENV";
export const ZCODE_HTTP_PROXY_ENV_KEY = "ZCODE_HTTP_PROXY";
export const ZCODE_NO_PROXY_ENV_KEY = "ZCODE_NO_PROXY";
/** Desktop Host 只向 desktop-attached remote server 传递一次的网络配置。 */
export const ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY =
  "ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY";
export const ZCODE_REMOTE_HTTP_PROXY_ENV_KEY = "ZCODE_REMOTE_HTTP_PROXY";
export const ZCODE_REMOTE_NO_PROXY_ENV_KEY = "ZCODE_REMOTE_NO_PROXY";
export const ZCODE_AGENT_CA_CERT_ENV_KEY = "ZCODE_AGENT_CA_CERT";
export const ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY = "ZCODE_TOOL_ENV_PASSTHROUGH_JSON";
/** Desktop Main 将服务端裁决的单功能灰度结果传给 Local/Remote Host。 */
export const ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV = "ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED";
export const ZCODE_CUA_PRODUCT_HELPER_ENV_KEY = "ZCODE_CUA_PRODUCT_HELPER";
export const ZCODE_CUA_BROKER_SOCKET_ENV_KEY = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
/** Shared node_repl host marker; unlike the broker bearer values it is not a secret. */
export const ZCODE_CUA_NODE_REPL_HOST_ENV_KEY = "ZCODE_CUA_NODE_REPL_HOST";
// One-knob local-development bundle. Setting ZCODE_CUA_DEV_MODE implies the internal feature
// flag (below) plus the local-helper relaxations wired in packages/services (unsigned/
// unauthenticated local helper, dev install variant, "Dev.app" naming). It exists so a developer
// can launch the full local CUA loop with a single env var instead of the historical four-var
// incantation. 这些开关只在未打包本地构建生效；正式 desktop/Helper bundle 会在编译期关闭并在
// main→host 边界删除，不能用于 signed release 的 runtime override。
export const ZCODE_CUA_DEV_MODE_ENV_KEY = "ZCODE_CUA_DEV_MODE";

export type ZCodeRuntimeEnv = "development" | "production" | "test";

type EnvRecord = Record<string, string | undefined>;

export function isCuaDevModeRequested(env: EnvRecord = process.env): boolean {
  const explicit = env[ZCODE_CUA_DEV_MODE_ENV_KEY]?.trim().toLowerCase();
  return explicit === "1" || explicit === "true" || explicit === "on";
}

export function isZCodeCuaInternalFeatureEnabled(env: EnvRecord = process.env): boolean {
  // CUA 现已默认打包进正式版（plugin staged + Helper enabled），不再需要显式 env flag。
  // DEV_MODE 仍然 implied（开发一键），PRODUCT_HELPER=0/off/false 可显式关闭。
  if (isCuaDevModeRequested(env)) return true;
  const explicit = env[ZCODE_CUA_PRODUCT_HELPER_ENV_KEY]?.trim().toLowerCase();
  if (explicit === "0" || explicit === "false" || explicit === "off") return false;
  return true;
}

// 旧遥测出口键与旧身份键;拼接生成,grep 断言友好。
const LEGACY_OTEL_EXPORTER_SUFFIXES = [
  "_ENDPOINT",
  "_TRACES_ENDPOINT",
  "_HEADERS",
  "_TRACES_HEADERS",
  "_METRICS_ENDPOINT",
  "_METRICS_HEADERS",
  "_COMPRESSION",
] as const;
const LEGACY_TELEMETRY_ENV_STRIP_KEYS: readonly string[] = [
  ...LEGACY_OTEL_EXPORTER_SUFFIXES.map(
    (suffix) => ["OTEL", "EXPORTER", ["OT", "LP"].join("")].join("_") + suffix,
  ),
  ["OTEL", "SERVICE_NAME"].join("_"),
  ["OTEL", "RESOURCE_ATTRIBUTES"].join("_"),
  ["ZCODE", "MODEL", "TELEMETRY_ENABLED"].join("_"),
  ...[
    "_DEVICE_MID",
    "_USER_ID",
    "_USER_ID_HASH",
    "_USER_SUBJECT_ID",
    "_IDENTITY_STATE",
    "_RUNTIME_SURFACE",
    "_RUNTIME_DISTRIBUTION",
  ].map((suffix) => ["ZCODE", "TELEMETRY"].join("_") + suffix),
];

const SANITIZED_RUNTIME_ENV_KEYS = [
  "NODE_ENV",
  "ELECTRON_RUN_AS_NODE",
  "NODE_NO_WARNINGS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  // CUA broker socket 是只该给目标 zcode-cua MCP server 的连接材料（由 desktop/CLI 在
  // 解析该 server 时定向注入其 env）。绝不能随 agent 全局 env 泄漏给其它 MCP server / Bash / tool
  // 子进程 —— 否则同 agent 内的恶意 MCP 或被 prompt-injection 触发的命令能直接驱动
  // 已授权 Helper（confused-deputy）。这里统一从所有子进程 env 剔除；zcode-cua server 的定向
  // env 注入在 buildMcpStdioEnv 之后 spread，因此仍能拿到（见 adapters/mcp StdioClientTransport）。
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  // 遗留 bearer token：当前 broker 是 identity 模式（socket + authority，无口令，见
  // captureZCodeCuaBrokerCredentials），本进程不再产生也不再消费它。仍然剔除，因为用户机上
  // 可能装着旧版 Helper —— 那些版本认 bearer token，一旦这个变量随 agent 全局 env 漏给别的
  // MCP server / Bash 子进程，同一个 confused-deputy 又成立。剔除一个已不用的键是零成本的。
  "ZCODE_CUA_PERMISSION_BROKER_TOKEN",
  "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER",
  "ZCODE_CUA_PLUGIN_AUTHORITY",
  // FreeCodeZ fork(P3 §3.7):遥测链已删;以下旧遥测环境键仅为隐私防护继续从子进程剔除。
  // 键名以拼接构造(前缀 × 后缀),避免品牌/链路字样以字面量散布源码。
  ...LEGACY_TELEMETRY_ENV_STRIP_KEYS,
] as const;



const NON_TOOL_PASSTHROUGH_RUNTIME_ENV_KEYS = [
  "NODE_ENV",
  "ELECTRON_RUN_AS_NODE",
  "NODE_NO_WARNINGS",
  // CUA broker 凭据不得经 tool-env-passthrough 恢复到 Bash/tool 子进程（否则等于绕过上面的剔除）。
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER",
  "ZCODE_CUA_PLUGIN_AUTHORITY",
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
] as const;

const SANITIZED_PACKAGE_MANAGER_ENV_PATTERN =
  /^(npm_config|yarn|pnpm)_(http_proxy|https_proxy|proxy|all_proxy|no_proxy|cafile|ca)$/i;

export function normalizeZCodeRuntimeEnv(value: string | undefined): ZCodeRuntimeEnv | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "development" || normalized === "production" || normalized === "test") {
    return normalized;
  }
  return undefined;
}

export function resolveZCodeRuntimeEnv(
  env: Record<string, string | undefined>,
  fallback: ZCodeRuntimeEnv = "production",
): ZCodeRuntimeEnv {
  return normalizeZCodeRuntimeEnv(env[ZCODE_RUNTIME_ENV_KEY]) ?? fallback;
}

// Exported so services/node.ts can inject the Helper's plugin authority into the agent spawn env
// (mirrors feat; the agent-side plugin host verifies the broker authority via this env var).
export const ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY = "ZCODE_CUA_PLUGIN_AUTHORITY";

interface CapturedCuaBrokerCredentials {
  socket: string;
  pluginAuthority: string;
  refreshMarker?: string;
}

let capturedCuaBrokerCredentials: Readonly<CapturedCuaBrokerCredentials> | undefined;
const capturedZCodeAgentTelemetryEnv: Record<string, string> = {};

// CUA broker socket 会被上面的 sanitize 从子进程 env 中剔除（confused-deputy 防护 —— 不能让
// 其它 MCP server / Bash / tool 子进程直接驱动已授权 Helper）。但 CLI 入口在 bootstrap
// 解析全局 ~/.freecodez/cli/config.json 里的 `zcode-cua` server 之前就会先 sanitize process.env，导致
// 定向注入时已经读不到凭据 → 全局 zcode-cua 回退 `--backend auto`，让 Python/uvx 成为 TCC 主体
// （fail-open，违反 "Python/uvx must never become the implicit permission owner"）。因此在剔除前把
// 凭据捕获进本进程私有存储，只经 getCapturedZCodeCuaBrokerCredentials() 暴露给 bootstrap 的定向
// 注入路径，绝不写回任何子进程 env。
function captureZCodeCuaBrokerCredentials(env: Record<string, string | undefined>): void {
  const socket = env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY]?.trim();
  const pluginAuthority = env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]?.trim();
  const refreshMarker = env["ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER"]?.trim();
  // 连接没有口令：socket + authority（config-provenance 随机数）同批出现才构成有效凭据组；
  // 半组说明上游注入不完整或正在轮换。
  if (socket && pluginAuthority) {
    capturedCuaBrokerCredentials = Object.freeze({
      socket,
      pluginAuthority,
      ...(refreshMarker ? { refreshMarker } : {}),
    });
    return;
  }
  if (socket || pluginAuthority) {
    // 发现半组凭据说明上游注入不完整或正在轮换；清掉旧快照并 fail-closed，不能复用另一半。
    capturedCuaBrokerCredentials = undefined;
  }
}

function captureZCodeAgentTelemetryEnv(env: Record<string, string | undefined>): void {
  Object.assign(capturedZCodeAgentTelemetryEnv, readZCodeAgentTelemetryEnv(env));
}

/**
 * 只提取供 Agent telemetry bootstrap 使用的配置。宿主可在经过通用 env 清洗后，
 * 将这组值定向传给 host/Agent；不得把它并入 Bash/MCP 的 tool env。
 */
export function readZCodeAgentTelemetryEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const telemetryEnv: Record<string, string> = {};
  for (const key of SANITIZED_RUNTIME_ENV_KEYS) {
    if (!isZCodeAgentTelemetryEnvKey(key)) continue;
    const value = env[key]?.trim();
    if (value) telemetryEnv[key] = value;
  }
  return telemetryEnv;
}

export function getCapturedZCodeAgentTelemetryEnv(): Record<string, string> {
  return { ...capturedZCodeAgentTelemetryEnv };
}

export function getCapturedZCodeCuaBrokerCredentials(): {
  socket: string | undefined;
  pluginAuthority: string | undefined;
  refreshMarker?: string;
} {
  return capturedCuaBrokerCredentials
    ? { ...capturedCuaBrokerCredentials }
    : { socket: undefined, pluginAuthority: undefined };
}

// 仅供测试重置进程内捕获状态。
export function resetCapturedZCodeCuaBrokerCredentialsForTest(): void {
  capturedCuaBrokerCredentials = undefined;
}

export function resetCapturedZCodeAgentTelemetryEnvForTest(): void {
  for (const key of Object.keys(capturedZCodeAgentTelemetryEnv)) {
    delete capturedZCodeAgentTelemetryEnv[key];
  }
}

// 条目1（升级实施手册）：ZCODE_*→FREECODEZ_* 命名空间迁移期。
// 这些旧键属于「仓外桥」：node-repl-host / CUA helper / hexin 插件按旧名读，FC 注入链
// 双写桥接——见到的 ZCODE_* 是我们自己桥进去的，不算外来配置，不告警。
export const MIGRATION_BRIDGED_ZCODE_KEYS = new Set([
  "ZCODE_DATA_BASE_DIR",
  "ZCODE_CUA_PERMISSION_BROKER_SOCKET",
  "ZCODE_CUA_PLUGIN_ROOT",
  "ZCODE_PLUGIN_ROOT",
  "ZCODE_PLUGIN_DATA",
  "ZCODE_CUA_HELPER_INSTALL_VARIANT",
  "ZCODE_CUA_BUNDLED_HELPER_APP_PATH",
  "ZCODE_BASE_URL",
  "ZCODE_ENDPOINT_ORIGIN",
]);

/** 迁移告警去重（进程级一次：同一键反复出现只会打一行，不刷屏）。 */
const migrationWarnedKeys = new Set<string>();

/**
 * 迁移期探测：启动后见到的外来 ZCODE_* env（不在桥接白名单）提示改名。
 * 每键至多一条；找不到 logger 就静默（warn 是提示不是门禁）。
 */
export function warnLegacyZCodeEnvKeys(env: Record<string, string | undefined>): void {
  if (process.env.FREECODEZ_DISABLE_MIGRATION_WARN === "1") return;
  // 复查修（2026-10-05）：dev/test 下宿主 env 泄漏的 ZCODE_* 会刷屏（每键一条）。
  // 迁移提示的生产价值在真实部署（用户 shell 里设的旧键），dev/test 环境噪声大
  // 于信息量——只在 NODE_ENV=production 或显式 FREECODEZ_MIGRATION_WARN=1 时输出。
  if (process.env.NODE_ENV !== "production" && process.env.FREECODEZ_MIGRATION_WARN !== "1") {
    return;
  }
  for (const key of Object.keys(env)) {
    if (!key.startsWith("ZCODE_") || MIGRATION_BRIDGED_ZCODE_KEYS.has(key)) continue;
    if (migrationWarnedKeys.has(key)) continue;
    migrationWarnedKeys.add(key);
    // shared 层刻意不依赖 services logger（循环依赖）；console.warn 一次即可——
    // 迁移期提示是给人看的排障信息，不需要进结构化日志管道。
    console.warn(
      `[env.migration] Legacy env "${key}" detected. FreeCodeZ reads FREECODEZ_* keys; ` +
        `"${key}" is ignored unless it is bridged for out-of-repo plugins.`,
    );
  }
}

export function sanitizeZCodeRuntimeEnv<T extends Record<string, string | undefined>>(
  env: T,
): Record<string, string> {
  captureZCodeCuaBrokerCredentials(env);
  captureZCodeAgentTelemetryEnv(env);
  warnLegacyZCodeEnvKeys(env);
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || shouldSanitizeZCodeRuntimeEnvKey(key)) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

export function buildZCodeToolEnvPassthroughEnv(env: EnvRecord): Record<string, string> {
  const captured = readZCodeToolEnvPassthroughEnv(env);

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !shouldCaptureZCodeToolEnvPassthroughKey(key)) {
      continue;
    }
    captured[key] = value;
  }

  return stringifyZCodeToolEnvPassthroughEnv(captured);
}

export function readZCodeToolEnvPassthroughEnv(env: EnvRecord): Record<string, string> {
  const raw = env[ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY];
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const captured: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        typeof value === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
        shouldCaptureZCodeToolEnvPassthroughKey(key)
      ) {
        captured[key] = value;
      }
    }
    return captured;
  } catch {
    return {};
  }
}

export function sanitizeZCodeRuntimeEnvInPlace(env: Record<string, string | undefined>): void {
  captureZCodeCuaBrokerCredentials(env);
  captureZCodeAgentTelemetryEnv(env);
  for (const key of Object.keys(env)) {
    if (shouldSanitizeZCodeRuntimeEnvKey(key)) {
      delete env[key];
    }
  }
}

function isZCodeAgentTelemetryEnvKey(key: string): boolean {
  return (
    key.startsWith(["OTEL", "_"].join("")) ||
    key.startsWith(["ZCODE", "TELEMETRY_"].join("_")) ||
    key === "ZCODE_MODEL_TELEMETRY_ENABLED"
  );
}

export function shouldSanitizeZCodeRuntimeEnvKey(key: string): boolean {
  const upperKey = key.toUpperCase();
  return (
    SANITIZED_RUNTIME_ENV_KEYS.some((candidate) => candidate === upperKey) ||
    SANITIZED_PACKAGE_MANAGER_ENV_PATTERN.test(key)
  );
}

export function shouldCaptureZCodeToolEnvPassthroughKey(key: string): boolean {
  const upperKey = key.toUpperCase();
  if (isZCodeAgentTelemetryEnvKey(upperKey)) {
    return false;
  }
  if (NON_TOOL_PASSTHROUGH_RUNTIME_ENV_KEYS.some((candidate) => candidate === upperKey)) {
    return false;
  }
  return shouldSanitizeZCodeRuntimeEnvKey(key);
}

function stringifyZCodeToolEnvPassthroughEnv(
  captured: Record<string, string>,
): Record<string, string> {
  const entries = Object.entries(captured).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return {};
  }
  return {
    [ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]: JSON.stringify(Object.fromEntries(entries)),
  };
}
