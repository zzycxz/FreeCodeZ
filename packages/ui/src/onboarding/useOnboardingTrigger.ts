import type { AppSettings } from "@zcode/shared";
import type { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";

/**
 * FreeCodeZ fork(model-provider-intake R2/B1)：职业引导不再在冷启动自动触发。
 * 首屏已由「添加供应商」接入面（WelcomeScreen → ProviderTemplatePicker）取代，
 * 职业引导只保留设置页手动入口（newUserOnboardingOpen）；原按本地记录的自动判定
 * 与换号回填（账号概念）随 bigmodel+zai 账号族一并退役。
 *
 * 返回 [needsOnboarding, markOnboarded]：needsOnboarding 恒为 false（不自动触发），
 * markOnboarded 保留保存后的收尾契约（记录落盘后不再触发同会话引导）。
 */
export function useOnboardingTrigger(_options: {
  onboardingRecord: ReturnType<typeof useOnboardingRecordService>;
  userId: string | null;
  hasStoredOccupation: boolean;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}): [boolean | null, () => void] {
  return [false, () => {}];
}
