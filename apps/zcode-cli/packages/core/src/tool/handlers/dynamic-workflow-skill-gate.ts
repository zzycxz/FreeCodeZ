// ============================================================
// dynamic-workflows skill 门控（上游 3.14.3 R1 的移植）
// ============================================================
// 会话未加载 `dynamic-workflows` 技能时，四个脚本类工具在 resolveInput（归一化之前）
// 以 errorCode 428 拒收脚本，报错引导先调 Skill 工具；`saved`-only 运行与纯设置修订豁免。
// 与上游同位（resolveInput 首步）：门控失败发生在 hook/权限/确认窗之前，Nothing was started。
//
// 事实源是会话的已加载技能集合（executor 的 loadedSkillIds，Skill 工具执行成功即记入）；
// `hasLoadedSkill` 缺席的宿主按已加载处理——向后兼容无该能力的旧接线，避免门控恒拒。

import type { ToolHandlerFailure, ToolInputResolutionContext } from "../types.js";

export const DYNAMIC_WORKFLOW_SKILL_ID = "dynamic-workflows";
/** 428 Precondition Required：技能未加载，先满足前置条件再重试。 */
export const DYNAMIC_WORKFLOW_SKILL_REFUSAL_CODE = 428;

export function isDynamicWorkflowSkillLoaded(
  context: Pick<ToolInputResolutionContext, "hasLoadedSkill">,
): boolean {
  return context.hasLoadedSkill?.(DYNAMIC_WORKFLOW_SKILL_ID) ?? true;
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

/** CreateWorkflow：仅 `saved`-only（无 script/path）豁免；其余来源都携带脚本，须先加载技能。 */
export function createWorkflowNeedsSkill(input: unknown): boolean {
  const record = asRecord(input);
  if (record === undefined) return true;
  return !(record.saved !== undefined && record.script === undefined && record.path === undefined);
}

/** AmendWorkflow：带 `script` 或 `path` 才需要技能；纯设置修订（只改 max_concurrency / subagent_model）豁免。 */
export function amendWorkflowNeedsSkill(input: unknown): boolean {
  const record = asRecord(input);
  if (record === undefined) return true;
  return record.script !== undefined || record.path !== undefined;
}

/** 门控本体：已加载（或宿主无该能力）返回 null 放行，否则返回 428 拒收。文案照抄官方引导。 */
export function requireDynamicWorkflowSkill(
  tool: string,
  context: Pick<ToolInputResolutionContext, "hasLoadedSkill">,
): ToolHandlerFailure | null {
  if (isDynamicWorkflowSkillLoaded(context)) return null;
  return {
    result: false,
    errorCode: DYNAMIC_WORKFLOW_SKILL_REFUSAL_CODE,
    message: `${tool} needs the \`${DYNAMIC_WORKFLOW_SKILL_ID}\` skill loaded in this session before it accepts a script. Call the Skill tool with skill "${DYNAMIC_WORKFLOW_SKILL_ID}" first — it carries the facade declarations the script is checked against, the authoring rules and this tool's full contract — then call ${tool} again. Nothing was started.`,
  };
}
