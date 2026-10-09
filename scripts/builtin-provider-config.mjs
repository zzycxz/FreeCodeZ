import { loadEndpointEnv } from "./load-endpoint-env.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** @param {{root?: string, env?: Record<string, string | undefined>}} options */
export async function resolveBuiltinProviderBuildEnvironment({
  root = repositoryRoot,
  env = process.env,
} = {}) {
  let value = (env.FREECODEZ_ENV ?? env.ZCODE_ENV);
  if (!value?.trim()) {
    const files = [
      ".env",
      ...(env.NODE_ENV === "production"
        ? [".env.production"]
        : [".env.development", ".env.development.local"]),
    ];
    for (const file of files) {
      let content;
      try {
        content = await readFile(resolve(root, file), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const parsed = parseEnv(content);
      if (parsed.ZCODE_ENV !== undefined) value = parsed.ZCODE_ENV;
    }
  }
  const normalized = value?.trim().toLowerCase() || "test";
  if (normalized !== "test" && normalized !== "production") {
    throw new Error(`Invalid ZCODE_ENV for Built-in Provider build: ${normalized}`);
  }
  return normalized;
}

/** @param {{root?: string, env?: Record<string, string | undefined>}} options */
async function readValidatedBuiltinProviderConfig(sourcePath) {
  const content = await readFile(sourcePath, "utf8");
  // 构建期复用运行时的完整 Release 校验，避免打包成功后才发现 Schema 不兼容。
  // tsx 仅供构建工具加载仓库 TS，不进入产品 bundle，也不复制一份校验规则。
  // Windows 绝对路径的盘符会被 ESM 当作协议，转为 file URL 后各平台共用同一加载入口。
  const { decodeZCodeBuiltinRelease } = await tsImport(
    pathToFileURL(resolve(repositoryRoot, "packages/provider-node/src/zcode-builtin-release.ts"))
      .href,
    import.meta.url,
  );
  decodeZCodeBuiltinRelease(JSON.parse(content));
  return content;
}

// env 泄漏防护（2026-10-07，同 6a60069 运行时 resolver 语义）：宿主 ZCode 的 shell 集成会把
// ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 写进会话环境，指向官方运行时配置（oauth/account access
// 形态）；FC 的 fork schema 只认 api-key/none，直读必炸构建。构建脚本不经 CLI 启动清洗（D1）
// 也不经 GUI 运行时预检（6a60069），此前是泄漏坑的存活面。显式路径先过同一份 fork schema
// 预检：兼容 → 采信（保留 CI/端点显式指定配置的能力）；不兼容/不存在 → warn 一次 + 回退
// 仓库自带基线（外来文件不可信，校验不过不打死构建）。
const foreignProviderConfigWarned = new Set();

/** @param {{root?: string, env?: Record<string, string | undefined>}} options */
export async function loadBuiltinProviderConfig({ root = repositoryRoot, env = process.env } = {}) {
  env = await loadEndpointEnv({ root, env });
  const environment = await resolveBuiltinProviderBuildEnvironment({ root, env });
  const explicit = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim();
  if (explicit) {
    const explicitSourcePath = resolve(root, explicit);
    try {
      const content = await readValidatedBuiltinProviderConfig(explicitSourcePath);
      return { environment, sourcePath: explicitSourcePath, content };
    } catch (error) {
      if (!foreignProviderConfigWarned.has(explicitSourcePath)) {
        foreignProviderConfigWarned.add(explicitSourcePath);
        console.warn(
          `[builtin-provider] explicit config failed fork schema validation, falling back to repo baseline: ` +
            `${explicitSourcePath} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
  }
  const sourcePath = resolve(root, "config/provider/zcode-builtin.json");
  try {
    const content = await readValidatedBuiltinProviderConfig(sourcePath);
    return { environment, sourcePath, content };
  } catch (error) {
    throw new Error(`Invalid Built-in Provider config (${environment}): ${sourcePath}`, {
      cause: error,
    });
  }
}

/** @param {{directory: string, root?: string, env?: Record<string, string | undefined>}} options */
export async function stageBuiltinProviderConfig({ directory, ...options }) {
  const config = await loadBuiltinProviderConfig(options);
  await mkdir(directory, { recursive: true });
  // bootstrap 可以复用 JS，但不能连带复用上一环境／上一版本的独立配置资源。
  await writeFile(resolve(directory, "zcode-builtin.json"), config.content, "utf8");
  return config;
}
