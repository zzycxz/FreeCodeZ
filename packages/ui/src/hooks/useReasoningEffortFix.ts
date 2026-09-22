import { useCallback } from "react";
import {
  getReasoningLevelPreset,
  type ReasoningLevelPresetId,
} from "@zcode/shared/reasoning-effort-recovery";
import type { ModelSelectionView } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useProviderSettingsServiceView } from "@/hooks/useProviderSettingsView.js";
import { logger } from "@/logger.js";

export interface ReasoningEffortFix {
  /** 目标模型可解析（当前选择 + 设置视图就绪）才可一键修复。 */
  readonly available: boolean;
  /** 返回是否落库成功；只有用户点击才写配置（spec §2.3 L2）。 */
  apply(presetId: ReasoningLevelPresetId): Promise<boolean>;
}

/**
 * L2 一键持久修复（docs/spec/model-reasoning-level-presets.md §2.3）：
 * 推理档位被模型接口拒绝时，把安全档位写回当前模型的个人配置。
 * 与模型草稿同一条保存链路（savePersonalModelDraft），不新增第二条写路径。
 */
export function useReasoningEffortFix(target: {
  modelSelectionView?: ModelSelectionView | null;
}): ReasoningEffortFix | null {
  const { providerSettingsService } = useServices();
  const settingsRead = useProviderSettingsServiceView(providerSettingsService);
  const settingsView = settingsRead.state.status === "ready" ? settingsRead.state.view : null;
  const selection = target.modelSelectionView?.effectiveSelection ?? null;
  const available = Boolean(settingsView && selection);

  const apply = useCallback(
    async (presetId: ReasoningLevelPresetId): Promise<boolean> => {
      if (!settingsView || !selection) return false;
      const preset = getReasoningLevelPreset(presetId);
      const modelView = settingsView.providers
        .find((provider) => provider.providerId === selection.providerId)
        ?.models.find((model) => model.modelId === selection.modelId);
      if (!preset || !modelView) return false;
      try {
        const personalConfig = modelView.personalExactConfig ?? {};
        await providerSettingsService.savePersonalModelDraft({
          providerId: selection.providerId,
          originalModelId: selection.modelId,
          nextModelId: selection.modelId,
          personalConfig: {
            ...personalConfig,
            optionSpecs: {
              ...personalConfig.optionSpecs,
              reasoningLevel: {
                ...personalConfig.optionSpecs?.reasoningLevel,
                values: [...preset.values],
                ...(preset.mapOverride !== undefined ? { map: preset.mapOverride } : {}),
              },
            },
          },
          useRecommendedConfig: modelView.useRecommendedConfig,
          basedOnRevision: settingsView.revision,
        });
        return true;
      } catch (error) {
        logger.error("[useReasoningEffortFix] 推理档位修复保存失败", error as Error);
        return false;
      }
    },
    [providerSettingsService, settingsView, selection],
  );

  if (!available) return null;
  return { available, apply };
}
