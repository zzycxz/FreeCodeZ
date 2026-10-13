import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSettings } from "@/hooks/useSettingService.js";

// U2-5（移植自 ZCode 3.15.1 dynamicWorkflowMode 用户设置，上游
// settings.dynamicWorkflow.option.* 三态=禁用/通过命令启用/始终开启）：
// 设置键优先，env 灰度兜底（Main 是唯一决策者，见 desktopRuntimeEnv）。Host env 为
// spawn 期注入——切档对后续 spawn 的 Host 生效，常驻 Host 需重启会话/应用。

type DynamicWorkflowMode = "disabled" | "onDemand" | "alwaysOn";

const MODE_OPTIONS: ReadonlyArray<{ value: DynamicWorkflowMode | "default"; labelId: string }> = [
  { value: "default", labelId: "settings.dynamicWorkflow.option.default" },
  { value: "disabled", labelId: "settings.dynamicWorkflow.option.disabled" },
  { value: "onDemand", labelId: "settings.dynamicWorkflow.option.onDemand" },
  { value: "alwaysOn", labelId: "settings.dynamicWorkflow.option.alwaysOn" },
];

export function DynamicWorkflowSettingsBlock(): React.JSX.Element {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const [saving, setSaving] = useState(false);
  const mode: DynamicWorkflowMode | "default" = settings?.dynamicWorkflowMode ?? "default";

  const setMode = async (next: DynamicWorkflowMode | "default"): Promise<void> => {
    setSaving(true);
    try {
      // "default"=删除显式设置（undefined 不落 setting.json），回落 env 灰度语义。
      await update({
        dynamicWorkflowMode: next === "default" ? undefined : next,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.dynamicWorkflow.title" })}
        description={intl.formatMessage({ id: "settings.dynamicWorkflow.description" })}
        control={
          <Select
            value={mode}
            disabled={saving}
            onValueChange={(value) => void setMode(value as DynamicWorkflowMode | "default")}
          >
            <SelectTrigger
              size="lg"
              className="w-[220px] min-w-0 justify-between"
              aria-label={intl.formatMessage({ id: "settings.dynamicWorkflow.title" })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {intl.formatMessage({ id: option.labelId })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </SettingsGroupCard>
  );
}
