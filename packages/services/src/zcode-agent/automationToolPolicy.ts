export const AUTOMATION_MUTATION_TOOL_NAMES = ["CronCreate", "CronUpdate", "CronDelete"] as const;

export function mergeAutomationMutationToolDenylist(
  current: readonly string[] | undefined,
): string[] {
  const merged = new Set(current);
  for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
    merged.add(toolName);
  }
  return [...merged];
}

// 闲时派发轮只 deny OffPeakCreate（防止闲时任务递归自我派生、无限调度），OffPeakList 只读保留。
// 独立常量，绝不并入 AUTOMATION_MUTATION_TOOL_NAMES——cron automation 轮
// 明确放行 OffPeakCreate（定时派生闲时任务），混入会让 automation 轮误 deny。
export const OFF_PEAK_MUTATION_TOOL_NAMES = ["OffPeakCreate"] as const;

export function mergeOffPeakMutationToolDenylist(current: readonly string[] | undefined): string[] {
  const merged = new Set(current);
  for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
    merged.add(toolName);
  }
  return [...merged];
}

// A1：自动化会话（cron/闲时）的审批超时缺省（毫秒）。无人值守链路 ask 无人应答且
// 无看门狗，缺省无超时会永久挂起；超时后走 PermissionTimeout → deny + 留痕收口。
export const AUTOMATION_PERMISSION_TIMEOUT_MS = 120_000;

export function resolveAutomationPermissionTimeoutMs(params: {
  automationId?: string;
  offPeakTaskId?: string;
}): number | undefined {
  return params.automationId || params.offPeakTaskId
    ? AUTOMATION_PERMISSION_TIMEOUT_MS
    : undefined;
}
