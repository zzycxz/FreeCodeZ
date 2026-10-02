// A4 守卫测试需要对照"排序白名单里有、注册表里没有"的幽灵名（如 ScheduleWakeup），
// 因此导出该集合；它仍只影响排序，不代表任何工具存在。
export const SORTED_PROVIDER_TOOL_NAMES = new Set([
  "Agent",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "CronUpdate",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "LSP",
  "NotebookEdit",
  "Read",
  "ScheduleWakeup",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TodoRead",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
]);

export function orderProviderVisibleToolContracts<T extends { name: string }>(
  tools: readonly T[],
): T[] {
  const referenceTools: T[] = [];
  const localTools: T[] = [];
  for (const tool of tools) {
    if (SORTED_PROVIDER_TOOL_NAMES.has(tool.name)) {
      referenceTools.push(tool);
    } else {
      localTools.push(tool);
    }
  }

  return [
    ...referenceTools.sort((left, right) => left.name.localeCompare(right.name)),
    ...localTools,
  ];
}
