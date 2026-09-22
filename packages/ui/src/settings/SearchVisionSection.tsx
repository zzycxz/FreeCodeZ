// ============================================================
// FreeCodeZ fork(P6 §6.2/docs/spec/search-vision-settings.md §5)
// 「搜索与视觉」设置分区。展示形态对齐 fairpeer(用户 2026-09-22 拍板):
// 卡片级一行说明、每行 label+环境变量名、key 行显示已设置状态、
// 下拉用全局共享 Select 组件(与主题选择等设置一致),不逐行重复长文案。
// key 保存走加密凭据仓库(search:*),设置项只存开关/偏好/模型引用。
// ============================================================

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckIcon } from "lucide-react";
import { useModelSelectionView } from "@/hooks/useModelSelectionView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { SettingsBadge, SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

type SearchKeyProvider = "serpapi" | "brave" | "exa" | "linkup" | "anysearch";
type SummaryMode = "on" | "off" | "vlm";
type SafeSearch = "off" | "moderate" | "strict";

export interface SearchVisionSectionProps {
  activeWorkspacePath: string | null;
  searchSummaryMode: SummaryMode;
  searchSafeSearch: SafeSearch;
  searchCountry: string;
  visionUnderstandModel: string;
  onSearchSummaryModeChange: (mode: SummaryMode) => void | Promise<void>;
  onSearchSafeSearchChange: (mode: SafeSearch) => void | Promise<void>;
  onSearchCountryChange: (country: string) => void | Promise<void>;
  onVisionUnderstandModelChange: (value: string) => void | Promise<void>;
  onSearchProviderKeySave: (provider: SearchKeyProvider, key: string) => Promise<void>;
  onSearchProviderKeyDelete: (provider: SearchKeyProvider) => Promise<void>;
  onSearchProviderKeyStatus: (provider: SearchKeyProvider) => Promise<string | null>;
}

export function SearchVisionSection({
  activeWorkspacePath,
  searchSummaryMode,
  searchSafeSearch,
  searchCountry,
  visionUnderstandModel,
  onSearchSummaryModeChange,
  onSearchSafeSearchChange,
  onSearchCountryChange,
  onVisionUnderstandModelChange,
  onSearchProviderKeySave,
  onSearchProviderKeyDelete,
  onSearchProviderKeyStatus,
}: SearchVisionSectionProps) {
  const { intl } = useZCodeIntl();
  const format = (id: string) => intl.formatMessage({ id });
  const modelRead = useModelSelectionView(activeWorkspacePath);
  const view = modelRead.state.status === "ready" ? modelRead.state.view : null;

  // 只列 supportsImage 的模型;值为 providerId/modelId picker 格式,与 agent 侧
  // parseModelPickerValue 对齐。
  const visionModelOptions = useMemo(() => {
    if (!view) return [] as Array<{ value: string; label: string; group: string }>;
    return view.providers.flatMap((provider) => {
      const groupLabel = provider.providerName?.trim() || provider.providerId;
      return provider.models
        .filter((model) => model.config.properties?.inputFormat?.supportsImage === true)
        .map((model) => ({
          value: `${provider.providerId}/${model.modelId}`,
          label: model.modelId,
          group: groupLabel,
        }));
    });
  }, [view]);

  return (
    <div className="flex flex-col gap-4">
      {/* 卡1 网页搜索 */}
      <SettingsGroupCard>
        <SettingsRow
          label={format("settings.searchVision.webSearch.title")}
          description={format("settings.searchVision.webSearch.description")}
          control={<span />}
        />
        <SettingsRow
          label={format("settings.searchVision.summaryMode")}
          control={
            <Select
              value={searchSummaryMode}
              onValueChange={(next) => {
                void onSearchSummaryModeChange(next as SummaryMode);
              }}
            >
              <SelectTrigger size="lg" className="w-40 min-w-0 justify-between">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="on">on</SelectItem>
                <SelectItem value="off">off</SelectItem>
                <SelectItem value="vlm">vlm</SelectItem>
              </SelectContent>
            </Select>
          }
        />
        <SearchKeyRow
          label={format("settings.searchVision.key.brave")}
          envVar="BRAVE_API_KEY"
          provider="brave"
          onSave={onSearchProviderKeySave}
          onDelete={onSearchProviderKeyDelete}
          onStatus={onSearchProviderKeyStatus}
        />
        <SearchKeyRow
          label={format("settings.searchVision.key.exa")}
          envVar="EXA_API_KEY"
          provider="exa"
          onSave={onSearchProviderKeySave}
          onDelete={onSearchProviderKeyDelete}
          onStatus={onSearchProviderKeyStatus}
        />
        <SearchKeyRow
          label={format("settings.searchVision.key.linkup")}
          envVar="LINKUP_API_KEY"
          provider="linkup"
          onSave={onSearchProviderKeySave}
          onDelete={onSearchProviderKeyDelete}
          onStatus={onSearchProviderKeyStatus}
        />
        <SearchKeyRow
          label={format("settings.searchVision.key.anysearch")}
          envVar="ANYSEARCH_API_KEY"
          provider="anysearch"
          onSave={onSearchProviderKeySave}
          onDelete={onSearchProviderKeyDelete}
          onStatus={onSearchProviderKeyStatus}
        />
      </SettingsGroupCard>

      {/* 卡2 图片搜索 */}
      <SettingsGroupCard>
        <SettingsRow
          label={format("settings.searchVision.imageSearch.title")}
          description={format("settings.searchVision.imageSearch.description")}
          control={<span />}
        />
        <SearchKeyRow
          label={format("settings.searchVision.key.serpapi")}
          envVar="SERPAPI_API_KEY"
          provider="serpapi"
          onSave={onSearchProviderKeySave}
          onDelete={onSearchProviderKeyDelete}
          onStatus={onSearchProviderKeyStatus}
        />
        <SettingsRow
          label={format("settings.searchVision.safeSearch")}
          control={
            <Select
              value={searchSafeSearch}
              onValueChange={(next) => {
                void onSearchSafeSearchChange(next as SafeSearch);
              }}
            >
              <SelectTrigger size="lg" className="w-40 min-w-0 justify-between">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">off</SelectItem>
                <SelectItem value="moderate">moderate</SelectItem>
                <SelectItem value="strict">strict</SelectItem>
              </SelectContent>
            </Select>
          }
        />
        <CountryRow value={searchCountry} onSave={onSearchCountryChange} />
      </SettingsGroupCard>

      {/* 卡3 视觉模型(对齐 fairpeer「视觉模型」一行式) */}
      <SettingsGroupCard>
        <SettingsRow
          label={format("settings.searchVision.visionModel.title")}
          description={format("settings.searchVision.visionModel.description")}
          control={
            <Select
              value={visionUnderstandModel || "follow-session"}
              onValueChange={(next) => {
                void onVisionUnderstandModelChange(next === "follow-session" ? "" : next);
              }}
            >
              <SelectTrigger size="lg" className="w-80 min-w-0 justify-between">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="follow-session">
                  {format("settings.searchVision.visionModel.followSession")}
                </SelectItem>
                {visionModelOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span className="truncate">{`${option.group} / ${option.label}`}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingsGroupCard>

      {/* 卡4 网页转 Markdown:零配置能力的可见入口 */}
      <SettingsGroupCard>
        <SettingsRow
          label={format("settings.searchVision.webfetch.title")}
          description={format("settings.searchVision.webfetch.description")}
          control={<span />}
        />
      </SettingsGroupCard>
    </div>
  );
}

function CountryRow({
  value,
  onSave,
}: {
  value: string;
  onSave: (country: string) => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState(value);
  const trimmed = draft.trim();
  const dirty = trimmed !== value.trim();
  return (
    <SingleLineRow
      label={intl.formatMessage({ id: "settings.searchVision.country" })}
      control={
        <Button
          type="button"
          size="lg"
          disabled={!dirty || trimmed.length > 8}
          onClick={() => {
            void onSave(trimmed);
          }}
        >
          {intl.formatMessage({ id: "settings.searchVision.countrySave" })}
        </Button>
      }
    >
      <Input
        size="lg"
        value={draft}
        placeholder={intl.formatMessage({ id: "settings.searchVision.countryPlaceholder" })}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && dirty && trimmed.length <= 8) {
            void onSave(trimmed);
          }
        }}
        className="w-full min-w-0 font-mono"
      />
    </SingleLineRow>
  );
}

/**
 * 单行行容器(用户 2026-09-22 拍板的形态):名称(+徽标) | 环境变量名 | 弹性输入框 | 按钮
 * 全部同一水平线,且**固定四列网格**——label 列/环境变量列定宽、按钮列定宽并右对齐,
 * 保证各行输入框起点终点严格一致(徽标出现/消失、清除按钮出现都不再推移布局);
 * 窄屏(sm 以下)退化为纵向堆叠,不硬编码只适配桌面宽度。
 */
function SingleLineRow({
  label,
  envVar,
  badge,
  control,
  children,
}: {
  label: ReactNode;
  envVar?: string;
  badge?: ReactNode;
  control: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-x-3 gap-y-2 border-t border-border px-4 py-3 first:border-t-0 sm:grid-cols-[184px_150px_minmax(0,1fr)_128px] sm:items-center">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-ui-base font-medium text-foreground">{label}</span>
        {badge}
      </span>
      {envVar ? (
        <span className="truncate font-mono text-ui-sm text-foreground-subtle">{envVar}</span>
      ) : (
        <span className="hidden sm:block" aria-hidden="true" />
      )}
      {children}
      <div className="flex min-w-0 items-center justify-start gap-2 sm:justify-end">{control}</div>
    </div>
  );
}

/**
 * key 行:名称+已设置徽标 | 环境变量名 | 弹性输入框 | 清除/保存,单行布局。
 * placeholder 反映已设置状态,回车或按钮保存。
 */
function SearchKeyRow({
  label,
  envVar,
  provider,
  onSave,
  onDelete,
  onStatus,
}: {
  label: string;
  envVar: string;
  provider: SearchKeyProvider;
  onSave: (provider: SearchKeyProvider, key: string) => Promise<void>;
  onDelete: (provider: SearchKeyProvider) => Promise<void>;
  onStatus: (provider: SearchKeyProvider) => Promise<string | null>;
}) {
  const { intl } = useZCodeIntl();
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);
  const [isSet, setIsSet] = useState(false);
  const trimmed = value.trim();

  useEffect(() => {
    let cancelled = false;
    void onStatus(provider).then((existing) => {
      if (!cancelled) setIsSet(Boolean(existing));
    });
    return () => {
      cancelled = true;
    };
  }, [provider, onStatus]);

  const handleSave = () => {
    if (trimmed.length === 0) return;
    void onSave(provider, trimmed).then(() => {
      setValue("");
      setIsSet(true);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  };

  return (
    <SingleLineRow
      label={label}
      envVar={envVar}
      badge={
        isSet ? (
          <SettingsBadge>
            <span className="flex items-center gap-1">
              <CheckIcon className="size-3" />
              {intl.formatMessage({ id: "settings.searchVision.key.setBadge" })}
            </span>
          </SettingsBadge>
        ) : null
      }
      control={
        <>
          {isSet ? (
            <Button
              type="button"
              variant="ghost"
              size="lg"
              onClick={() => {
                void onDelete(provider).then(() => {
                  setIsSet(false);
                  setValue("");
                });
              }}
            >
              {intl.formatMessage({ id: "settings.searchVision.key.clear" })}
            </Button>
          ) : null}
          <Button type="button" size="lg" disabled={trimmed.length === 0} onClick={handleSave}>
            {saved
              ? intl.formatMessage({ id: "settings.searchVision.key.saved" })
              : intl.formatMessage({ id: "settings.searchVision.key.save" })}
          </Button>
        </>
      }
    >
      <Input
        size="lg"
        type="password"
        value={value}
        placeholder={
          isSet
            ? intl.formatMessage({ id: "settings.searchVision.key.placeholderSet" })
            : intl.formatMessage({ id: "settings.searchVision.key.placeholder" })
        }
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") handleSave();
        }}
        className="w-full min-w-0 font-mono"
      />
    </SingleLineRow>
  );
}
