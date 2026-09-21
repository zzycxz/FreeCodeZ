import { ModelSelectionFacade, type ProviderRegistryFacadeSource } from "@zcode/provider";
import { isBuiltinModelProviderId } from "@zcode/shared";
import { resolveLegacyReasoningLevel } from "./legacy-reasoning-level.js";

/** Host 与受管理 Worker 共用身份分类；解析仍由纯 Provider Facade 负责。 */
export function createNodeModelSelectionFacade(
  source: ProviderRegistryFacadeSource,
): ModelSelectionFacade {
  return new ModelSelectionFacade(
    source,
    (providerId) => {
      // FreeCodeZ fork:账号套餐/闲时身份分类已随账号体系删除(规格书 P2 §4.2);
      // Start Plan 特判一并移除,内置厂商按 ordinary 解析。
      if (isBuiltinModelProviderId(providerId)) return "account-plan";
      return "ordinary";
    },
    resolveLegacyReasoningLevel,
  );
}
