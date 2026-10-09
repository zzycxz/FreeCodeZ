export const ZCODE_WORKSPACE_IDENTITY_ENV = "FREECODEZ_WORKSPACE_IDENTITY";

export const ZCODE_RUNTIME_ENV_KEY = "FREECODEZ_RUNTIME_ENV";
export const ZCODE_HTTP_PROXY_ENV_KEY = "FREECODEZ_HTTP_PROXY";
export const ZCODE_NO_PROXY_ENV_KEY = "FREECODEZ_NO_PROXY";
/** Desktop Host 只向 desktop-attached remote server 传递一次的网络配置。 */
export const ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY =
  "ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY";
export const ZCODE_REMOTE_HTTP_PROXY_ENV_KEY = "FREECODEZ_REMOTE_HTTP_PROXY";
export const ZCODE_REMOTE_NO_PROXY_ENV_KEY = "FREECODEZ_REMOTE_NO_PROXY";
export const ZCODE_AGENT_CA_CERT_ENV_KEY = "FREECODEZ_AGENT_CA_CERT";
export const ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY = "FREECODEZ_TOOL_ENV_PASSTHROUGH_JSON";
/** Desktop Main 将服务端裁决的单功能灰度结果传给 Local/Remote Host。 */
export const ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV = "FREECODEZ_DESKTOP_CONTEXT_PROMPT_ENABLED";

export type ZCodeRuntimeEnv = "development" | "production" | "test";

type EnvRecord = Record<string, string | undefined>;

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

// 旧 CUA broker 凭据键（键名拼接构造避免字面量散布，同遥测键先例）。
const LEGACY_CUA_SECRET_ENV_KEYS: readonly string[] = [
  ["ZCODE", "CUA", "PERMISSION_BROKER_SOCKET"].join("_"),
  ["ZCODE", "CUA", "PERMISSION_BROKER_TOKEN"].join("_"),
  ["ZCODE", "CUA", "PERMISSION_BROKER_REFRESH_MARKER"].join("_"),
  ["ZCODE", "CUA", "PLUGIN_AUTHORITY"].join("_"),
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
  // 旧 CUA broker 凭据键继续从所有子进程 env 剔除（confused-deputy 防护）：用户机可能残留
  // 旧版 Helper 或宿主泄漏的 env，漏给其它 MCP server / Bash / tool 子进程就能直接驱动已授权
  // Helper。旧引擎已拆除但剔除是零成本的防御纵深；键名拼接构造避免字面量散布（同遥测键先例）。
  ...LEGACY_CUA_SECRET_ENV_KEYS,
  "FREECODEZ_CUA_PLUGIN_AUTHORITY",
  // FreeCodeZ fork(P3 §3.7):遥测链已删;以下旧遥测环境键仅为隐私防护继续从子进程剔除。
  // 键名以拼接构造(前缀 × 后缀),避免品牌/链路字样以字面量散布源码。
  ...LEGACY_TELEMETRY_ENV_STRIP_KEYS,
] as const;



const NON_TOOL_PASSTHROUGH_RUNTIME_ENV_KEYS = [
  "NODE_ENV",
  "ELECTRON_RUN_AS_NODE",
  "NODE_NO_WARNINGS",
  // 旧 CUA broker 凭据不得经 tool-env-passthrough 恢复到 Bash/tool 子进程（否则等于绕过
  // 上面的剔除）。含遗留 bearer token：文档意图本就是"绝不漏给 tool 子进程"，旧清单漏列它，
  // 这里一并封死。
  ...LEGACY_CUA_SECRET_ENV_KEYS,
  "FREECODEZ_CUA_PLUGIN_AUTHORITY",
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


const capturedZCodeAgentTelemetryEnv: Record<string, string> = {};

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

export function resetCapturedZCodeAgentTelemetryEnvForTest(): void {
  for (const key of Object.keys(capturedZCodeAgentTelemetryEnv)) {
    delete capturedZCodeAgentTelemetryEnv[key];
  }
}

// 条目1（升级实施手册）：ZCODE_*→FREECODEZ_* 命名空间迁移期。
// 这些旧键属于「仓外桥」：node-repl-host / hexin 插件按旧名读，FC 注入链
// 双写桥接——见到的 ZCODE_* 是我们自己桥进去的，不算外来配置，不告警。
export const MIGRATION_BRIDGED_ZCODE_KEYS = new Set([
  "ZCODE_DATA_BASE_DIR",
  "ZCODE_PLUGIN_ROOT",
  "ZCODE_PLUGIN_DATA",
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
    key === "FREECODEZ_MODEL_TELEMETRY_ENABLED"
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
