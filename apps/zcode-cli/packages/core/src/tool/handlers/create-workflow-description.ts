// 上游 3.14.3 的指针化描述（R2 / 拆包报告 3.5 移植）：facade DTS 与作者规则整体移入
// `dynamic-workflows` 技能（SKILL.md §16），常驻工具描述 30,137 → 1,886 字符——
// 每请求常驻工具区立省（三件合计 62,784 → 3,415，验收 A7）。技能未加载时 resolveInput
// 以 428 拒收脚本（见 dynamic-workflow-skill-gate.ts）。
// 文案逐字取自官方 3.14.3 装配（eha/tha/nha/rha）。

const INTRO =
  "Create and run a dynamic workflow: a TypeScript script that orchestrates multiple model-driven subagents with plain control flow (loops, conditionals, fan-out) and typed intermediate results. The script is typechecked, the user is asked to confirm it, and the run starts in the background; you are notified with its final result when it settles. Compilation errors come back as diagnostics.";

const WHEN_TO_USE = [
  "When to use:",
  '- The user explicitly asks for a workflow — "use a workflow", "with a workflow", "使用 workflow", "用工作流", or any phrasing that names workflow/工作流 as the means: this tool is mandatory. Do not substitute the Agent/Task subagent tools, do not do the work inline yourself, and do not judge the task too small for a workflow — the user chose the tool, and that choice is theirs. Size only decides how many subagents the script gets, never whether it is written.',
  "- Without such an explicit request, do not start a workflow: delegate with the Agent tool or do the work yourself, even for multi-step or multi-subagent tasks.",
].join("\n");

const SKILL_GATE =
  "Before writing or revising a script, load the `dynamic-workflows` skill with the Skill tool: it carries the facade declarations the script is checked against, the authoring rules, and this tool's full contract. A call that submits a script is refused until that skill has been loaded in this session; running a saved workflow by name is exempt.";

const SOURCES =
  "Pass exactly one source: `script` (a one-off script written inline; it is saved to a draft file the result names — revise that file and resubmit with `path`, never paste the script again), `saved` (a workflow saved in this project or globally, by name; check ListSavedWorkflows before writing one from scratch), or `path` (a script file on disk, normally the file a previous result named). To change a run that already exists — errored, completed, stopped or still running — call AmendWorkflow instead of starting over.";

export const CREATE_WORKFLOW_TOOL_DESCRIPTION = [
  INTRO,
  "",
  WHEN_TO_USE,
  "",
  SKILL_GATE,
  "",
  SOURCES,
].join("\n");
