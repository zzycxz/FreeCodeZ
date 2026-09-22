import type { ReactNode } from "react";
import type { ModelConfigObject } from "@zcode/provider";
import {
  REASONING_LEVEL_PRESETS,
  matchReasoningLevelPreset,
  type ReasoningLevelPreset,
  type ReasoningLevelPresetId,
} from "@zcode/shared/reasoning-effort-recovery";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ProviderModelDraftValues } from "@/settings/model-provider-section/ProviderModelMetadata.js";
import { JsonSlotEditor } from "@/settings/model-provider-section/ProviderModelMetadataFields.js";
import { ProviderModelReasoningLevelEditor } from "@/settings/model-provider-section/ProviderModelReasoningLevelEditor.js";
import { ModelConfigHelp } from "@/settings/model-provider-section/ModelConfigHelp.js";
import { Button } from "@/components/ui/button.js";

export function ModelSettingsGroup({
  group,
  children,
}: {
  group: "basic" | "tokens" | "modalities" | "capabilities" | "reasoning" | "advanced";
  children: ReactNode;
}) {
  return (
    <section className="space-y-4" data-model-settings-group={group}>
      {children}
    </section>
  );
}

export function ProviderModelReasoningSettings({
  draft,
  personalConfig,
  inheritedConfig,
  overrideFields,
  onDraftChange,
}: {
  draft: ProviderModelDraftValues;
  personalConfig?: ModelConfigObject;
  inheritedConfig?: ModelConfigObject;
  overrideFields?: ReadonlySet<string>;
  onDraftChange: (patch: Partial<ProviderModelDraftValues>) => void;
}) {
  const { intl } = useZCodeIntl();

  // 档位预设（spec §2.1）：把「填档位」变成「选档位」；chips 编辑器保留为预设之上的微调。
  const activePresetId = matchReasoningLevelPreset(draft.reasoningLevelValuesValue)?.id;
  const suggestedPresetId: ReasoningLevelPresetId | undefined = /think|reasoner/iu.test(
    draft.idValue,
  )
    ? "off-on"
    : undefined;
  const applyPreset = (preset: ReasoningLevelPreset) => {
    // 离开「无档位」时复位它写入的空 map，否则档位表已换、请求仍被阻断在零参数。
    const resetNoReasoningMap =
      preset.mapOverride === undefined && draft.reasoningLevelMapValue.trim() === "{}";
    onDraftChange({
      reasoningLevelValuesValue: [...preset.values],
      ...(preset.mapOverride !== undefined
        ? { reasoningLevelMapValue: preset.mapOverride }
        : resetNoReasoningMap
          ? { reasoningLevelMapValue: "" }
          : {}),
    });
  };

  return (
    <ModelSettingsGroup group="reasoning">
      <div className="space-y-1">
        <div className="block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.reasoningPreset" })}
        </div>
        <div className="flex flex-wrap gap-2" data-model-reasoning-presets="true">
          {REASONING_LEVEL_PRESETS.map((preset) => {
            // 启发式只做预选建议（spec §2.1）：ID 含 thinking/reasoner 时虚线高亮「仅开关」，
            // 不自动提交、不改用户已保存配置。
            const suggested =
              suggestedPresetId === preset.id && activePresetId !== preset.id ? "true" : undefined;
            return (
              <Button
                key={preset.id}
                type="button"
                size="sm"
                variant={activePresetId === preset.id ? "default" : "outline"}
                data-suggested={suggested}
                className={suggested ? "border-dashed" : undefined}
                title={intl.formatMessage({
                  id: `settings.modelProvider.reasoningPresetHint.${preset.id}`,
                })}
                onClick={() => applyPreset(preset)}
              >
                {intl.formatMessage({ id: `settings.modelProvider.reasoningPreset.${preset.id}` })}
              </Button>
            );
          })}
        </div>
      </div>
      <div className="space-y-1">
        <div className="block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.reasoningLevelsOrdered" })}
          <ModelConfigHelp field="reasoningLevelsOrdered" />
        </div>
        <ProviderModelReasoningLevelEditor
          values={draft.reasoningLevelValuesValue}
          overridden={
            overrideFields
              ? overrideFields.has("reasoningLevelValuesValue")
              : personalConfig?.optionSpecs?.reasoningLevel?.values !== undefined
          }
          addLabel={intl.formatMessage({ id: "settings.modelProvider.reasoningLevelAdd" })}
          deleteLabel={intl.formatMessage({
            id: "settings.modelProvider.reasoningLevelDelete",
          })}
          onChange={(reasoningLevelValuesValue) => onDraftChange({ reasoningLevelValuesValue })}
        />
      </div>
      <div data-model-reasoning-level-map-editor="true">
        <JsonSlotEditor
          label={intl.formatMessage({ id: "settings.modelProvider.reasoningLevelMapping" })}
          labelHelp={<ModelConfigHelp field="reasoningLevelMapping" />}
          value={draft.reasoningLevelMapValue}
          effectiveValue={
            draft.useRecommendedConfigValue === false
              ? undefined
              : (inheritedConfig?.optionSpecs?.reasoningLevel?.map ?? undefined)
          }
          overridden={
            overrideFields
              ? overrideFields.has("reasoningLevelMapValue")
              : personalConfig?.optionSpecs?.reasoningLevel?.map !== undefined
          }
          onChange={(reasoningLevelMapValue) => onDraftChange({ reasoningLevelMapValue })}
        />
      </div>
    </ModelSettingsGroup>
  );
}
