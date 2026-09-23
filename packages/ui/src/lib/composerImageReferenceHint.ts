// 输入框「引用+视觉工具处理」提示 chip 的可见性纯判定
// (spec search-vision-settings.md §4.3g;P7 §3.4 D1 的判定对象修正)。
// 数据源 ModelSelectionView:effectiveSelection 定位实际被发送的模型,
// providers[].models[].config.properties.inputFormat.supportsImage 判能力。

export interface ComposerImageReferenceHintInput {
  readonly effectiveSelection?: { providerId: string; modelId: string } | null;
  readonly preferredSelection?: { providerId: string; modelId: string } | null;
  readonly providers?: ReadonlyArray<{
    providerId: string;
    models?: ReadonlyArray<{
      modelId: string;
      config?: { properties?: { inputFormat?: { supportsImage?: boolean } } };
    }>;
  }>;
}

/**
 * 修复(2026-09-23):判定对象改为 effectiveSelection(草稿/会话当前选择,view 按
 * input 请求时携带);preferredSelection 只是新草稿初始推荐,裸默认选择被拒时会
 * 退回 Registry 顺序第一个模型,与输入框实际选中的模型无关——曾导致已声明
 * supportsImage 的模型误报「不支持直接读图」。无 effectiveSelection(草稿未选
 * 模型)才退 preferredSelection,两者都无时退视图第一个模型(与原兜底一致)。
 */
export function resolveComposerImageReferenceHintVisible(
  hasImageAttachment: boolean,
  view: ComposerImageReferenceHintInput | null | undefined,
): boolean {
  if (!hasImageAttachment) return false;
  const selected =
    view?.effectiveSelection ?? view?.preferredSelection ?? null;
  const provider = selected
    ? view?.providers?.find((candidate) => candidate.providerId === selected.providerId)
    : view?.providers?.[0];
  const modelEntry = selected
    ? provider?.models?.find((candidate) => candidate.modelId === selected.modelId)
    : provider?.models?.[0];
  return modelEntry?.config?.properties?.inputFormat?.supportsImage === false;
}
