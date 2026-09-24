// 上游 3.14.3 的指针化描述（R2）：缓存规则、省略即沿用与确认规则在 `dynamic-workflows` 技能里；
// 带 script/path 的调用在 resolveInput 以 428 拒收，纯设置修订豁免（见 dynamic-workflow-skill-gate.ts）。
// 文案逐字取自官方 3.14.3 装配（Z0o）。

export const AMEND_WORKFLOW_TOOL_DESCRIPTION = [
  "Amend an existing dynamic-workflow run with a revised script or revised settings. Starts a NEW run that supersedes the old one and imports its finished work as a cache, so only what you changed is paid for again. Works on ANY run of this project: completed, errored, stopped — or still running.",
  "",
  "When to use:",
  "- The run errored, or completed but needs one more stage: fix or extend the script and amend. Never rewrite the workflow from scratch with CreateWorkflow.",
  "- The run is STILL RUNNING and is visibly going wrong: amend it NOW, in one call. Do not TaskStop it first and do not wait for it to finish — this tool stops the running predecessor and starts the revision; the earlier you amend, the less is re-paid.",
  "- The user wants the same workflow with fewer subagents at once, its subagents on another model, or another name: amend with only that field and neither `path` nor `script`.",
  "- To continue a stopped run unchanged, use ResumeWorkflowRun instead.",
  "",
  "Load the `dynamic-workflows` skill with the Skill tool before revising a script: it carries the cache rules, what each omitted field keeps, and the confirmation rule. A call that passes `path` or `script` is refused until that skill has been loaded in this session; a settings-only call is not. Pass `path` (the run's script file, edited in place — the usual form) or `script` (the whole revised script inline), never both.",
].join("\n");
