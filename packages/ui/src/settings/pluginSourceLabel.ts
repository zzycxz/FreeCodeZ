import type { ZCodePluginMarketplaceSummary } from "@zcode/shared";

/**
 * 市场展示层的品牌映射（2026-10-07，D3 显示面条款）：官方插件市场的 id
 * `freecodez` 是契约面冻结（installed 登记、cache 路径、bootstrap
 * rootCandidates 都挂在它上面，改名断链），但用户可见的目录标题/来源标签必须显示
 * FreeCodeZ 品牌——id 原样露出等于把旧品牌名展示给用户。映射只动显示，不动元数据。
 */
const MARKETPLACE_DISPLAY_BRAND: Record<string, { "zh-CN": string; en: string }> = {
  "freecodez": { "zh-CN": "FreeCodeZ 官方插件", en: "FreeCodeZ Plugins" },
};

/**
 * 把 marketplace id 解析为对用户友好的展示名：
 * 品牌映射优先（仅显示层）；其次 marketplaces 概览里的 name，缺失时回落到原始 id。
 * 纯函数，便于在目录标题栏与已安装来源标签间复用同一套命名。
 */
export function resolveMarketplaceDisplayName(
  marketplaceId: string,
  marketplaces: readonly ZCodePluginMarketplaceSummary[],
  locale?: string,
): string {
  const brand = MARKETPLACE_DISPLAY_BRAND[marketplaceId];
  if (brand) {
    const localized = locale ? brand[locale as "zh-CN" | "en"] : undefined;
    return localized ?? brand.en;
  }
  const matched = marketplaces.find((marketplace) => marketplace.id === marketplaceId);
  return matched?.name ?? marketplaceId;
}
