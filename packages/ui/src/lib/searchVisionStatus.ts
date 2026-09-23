// 「搜索与视觉」设置分区·卡1 原生搜索状态行的纯映射(spec §5 / §4.3f-1)。
// 数据源 ModelSelectionView:effectiveSelection 定位当前模型,
// providers[].models[].config.properties.supportsNativeWebSearch 判能力。

export type NativeSearchStatus = "native" | "fallback" | "unknown";

export interface NativeSearchStatusInput {
  readonly effectiveSelection?: { providerId: string; modelId: string } | null;
  readonly providers?: ReadonlyArray<{
    providerId: string;
    models?: ReadonlyArray<{
      modelId: string;
      config?: { properties?: { supportsNativeWebSearch?: boolean } };
    }>;
  }>;
}

/**
 * 三态:当前模型声明原生搜索 → native;声明不支持或缺省 → fallback;
 * 无选择/模型不在视图(远端未就绪、provider 已删)→ unknown,不猜。
 */
export function resolveNativeSearchStatus(
  view: NativeSearchStatusInput | null | undefined,
): NativeSearchStatus {
  const selection = view?.effectiveSelection;
  if (!view || !selection?.providerId || !selection.modelId) return "unknown";
  const model = view.providers
    ?.find((provider) => provider.providerId === selection.providerId)
    ?.models?.find((candidate) => candidate.modelId === selection.modelId);
  if (!model?.config?.properties) return "unknown";
  return model.config.properties.supportsNativeWebSearch === true ? "native" : "fallback";
}
