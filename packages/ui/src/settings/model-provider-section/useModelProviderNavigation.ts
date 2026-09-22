/* FreeCodeZ fork(model-provider-intake R1):账号类预置入口(Z.ai/BigModel)与 Coding Plan
   连接项已随 bigmodel+zai 账号族整体移除；导航只保留「自定义供应商」分组与选中/回落逻辑。 */
import { useEffect, useMemo } from "react";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import {
  resolveModelProviderFamilySpecByProviderId,
  type ProviderFamilyConnectionSelection,
  type ProviderFamilyDomain,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ModelProviderNavGroup } from "@/settings/model-provider-section/constants.js";
import { createCustomProviderNodeKey } from "@/settings/model-provider-section/utils.js";
import {
  sortModelProvidersForDisplay,
  type ProviderOrderView,
} from "@/lib/modelProviderOrdering.js";

interface UseModelProviderNavigationOptions {
  modelProviders: ProviderSettingsFormProvider[];
  modelProvidersLoading?: boolean;
  displayOrder?: ProviderOrderView;
  familyConnectionSettingsFailed?: boolean;
  selectedNodeKey: string | null;
  setSelectedNodeKey: (key: string | null) => void;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
}

export function useModelProviderNavigation({
  modelProviders,
  modelProvidersLoading = false,
  displayOrder,
  familyConnectionSettingsFailed = false,
  selectedNodeKey,
  setSelectedNodeKey,
  intl,
}: UseModelProviderNavigationOptions) {
  const customProviders = useMemo(() => {
    const allCustomProviders = modelProviders.filter(
      (provider) => provider.config.group === "standard-personal",
    );
    // 这里复用模型菜单的展示排序，确保设置页和聊天框供应商顺序一致。
    return sortModelProvidersForDisplay(allCustomProviders, displayOrder);
  }, [displayOrder, modelProviders]);

  const navigationGroups = useMemo<ModelProviderNavGroup[]>(() => {
    return [
      {
        id: "custom",
        title: intl.formatMessage({ id: "settings.modelProvider.customTitle" }),
        items: customProviders.map((provider) => ({
          key: createCustomProviderNodeKey(provider.providerId),
          type: "custom" as const,
          label: getProviderFormLabel(provider),
          provider,
          statusActive: provider.executable === true,
        })),
      },
    ];
    // 左侧导航分组标题在 memo 内格式化。
    // 语言切换时 provider 引用可能不变，必须依赖 intl 才能刷新旧 locale 的文案。
  }, [customProviders, intl]);

  const navigationItems = useMemo(
    () => navigationGroups.flatMap((group) => group.items),
    [navigationGroups],
  );
  const selectableNavigationItems = useMemo(
    () =>
      navigationItems.filter(
        (item) => item.type !== "codingPlanLoading",
      ) as Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>[],
    [navigationItems],
  );
  const sideNavigationItemByKey = useMemo(
    () => new Map(selectableNavigationItems.map((item) => [item.key, item])),
    [selectableNavigationItems],
  );

  const selectedNavItem = selectedNodeKey
    ? (sideNavigationItemByKey.get(selectedNodeKey) ?? null)
    : null;
  // 设置读取失败时保留错误横幅；导航项本身与账号连接方式无关，不再做连接选择匹配。
  const navigationUnavailable = !modelProvidersLoading && familyConnectionSettingsFailed;

  const fallbackNodeKey = selectableNavigationItems[0]?.key ?? null;
  useEffect(() => {
    const hasSelectedNode = selectedNodeKey ? sideNavigationItemByKey.has(selectedNodeKey) : false;
    if (hasSelectedNode) {
      return;
    }

    if (selectedNodeKey !== fallbackNodeKey) {
      setSelectedNodeKey(fallbackNodeKey);
    }
  }, [fallbackNodeKey, selectedNodeKey, setSelectedNodeKey, sideNavigationItemByKey]);

  return {
    navigationGroups,
    navigationItems,
    selectedNavItem,
    navigationUnavailable,
  };
}

/**
 * 连接方式选择与导航项的匹配判定。
 * 账号族下线后仅供遗留 ProviderFamilyModeHeader 类型面保留；
 * `kind:"start-plan"` 是已持久化判别值（tombstone），一律视为不匹配。
 */
export function connectionSelectionMatchesNavigationItem(
  family: ProviderFamilyDomain,
  selection: ProviderFamilyConnectionSelection,
  item: Exclude<ModelProviderNavGroup["items"][number], { type: "codingPlanLoading" }>,
): boolean {
  if (item.type === "custom") return false;
  const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId ?? "");
  if (familySpec?.id !== family) return false;
  if (selection.kind === "start-plan") {
    return false;
  }
  if (selection.kind === "individual-coding-plan") {
    return (
      item.type === "codingPlan" && item.presetId === familySpec.individualCodingPlanProviderId
    );
  }
  return (
    item.type === "teamPlan" &&
    item.presetId === familySpec.teamCodingPlanProviderId &&
    // 团队连接按平台、组织和项目定位；订阅商品会在权益快照和 pricing 校正间变化。
    // 不能把同项目的商品更新误判为连接丢失，否则初始化会出现空选项和错误提示。
    item.organizationId === selection.organizationId &&
    item.projectId === selection.projectId
  );
}
