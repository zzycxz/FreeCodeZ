// ============================================================
// 显式 Builtin Provider 配置路径的兼容性预检与回退（纯件，零 electron 依赖）
// ============================================================
// 背景（2026-10-07 实证）：官方 ZCode 的 shell 集成会把
// ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 写进会话环境，指向官方运行时配置
//（~/.zcode/v2/runtime/provider/...，含 oauth 等 access 形态）。FreeCodeZ fork
// 的 schema（P2 之后）只认 api-key/none——宿主把该文件当 Bundled 读必炸 Zod，
// "Bundled 与 Active 均不可用"→agent 初始化失败、模型设置全空。
// 语义裁决：显式路径是**覆盖通道**而非安全边界——外来/损坏的覆盖文件不应打死
// agent；预检不过→告警一次+回退打包内置基线（不添麻烦/不熔断）。
import { readFileSync } from "node:fs";
import { decodeZCodeBuiltinRelease } from "@zcode/provider-node";

const explicitCompatibilityCache = new Map<string, boolean>();

/**
 * 显式配置文件能否被 FreeCodeZ 的 builtin release schema 解码（结果按路径缓存）。
 * 文件不存在/JSON 坏/schema 不兼容（官方 ZCode 配置即此形态）→ false。
 */
export function isExplicitBuiltinProviderConfigCompatible(explicitPath: string): boolean {
  const cached = explicitCompatibilityCache.get(explicitPath);
  if (cached !== undefined) return cached;
  let compatible = false;
  try {
    decodeZCodeBuiltinRelease(JSON.parse(readFileSync(explicitPath, "utf8")));
    compatible = true;
  } catch {
    compatible = false;
  }
  explicitCompatibilityCache.set(explicitPath, compatible);
  return compatible;
}

export type ExplicitProviderConfigFallbackReason = "incompatible" | "unreadable";

/**
 * 路径决策（纯）：显式路径存在且兼容 → 用之；否则回退 bundledPath 并回调告警。
 */
export function resolveBuiltinProviderConfigPath(input: {
  readonly explicitPath?: string;
  readonly bundledPath: string;
  readonly onFallback?: (explicitPath: string, reason: ExplicitProviderConfigFallbackReason) => void;
}): string {
  const explicitPath = input.explicitPath?.trim();
  if (!explicitPath) return input.bundledPath;
  if (isExplicitBuiltinProviderConfigCompatible(explicitPath)) return explicitPath;
  input.onFallback?.(explicitPath, "incompatible");
  return input.bundledPath;
}

/** 测试用：清空兼容性缓存。 */
export function __resetExplicitCompatibilityCacheForTest(): void {
  explicitCompatibilityCache.clear();
}
