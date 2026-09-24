// 上游 3.14.3 的指针化描述（R2）：文件格式、参数声明与作者规则在 `dynamic-workflows` 技能里；
// 技能未加载时 resolveInput 以 428 拒收（见 dynamic-workflow-skill-gate.ts）。
// 文案逐字取自官方 3.14.3 装配（Pbo）。

export const SAVE_WORKFLOW_TOOL_DESCRIPTION = [
  "Save a dynamic-workflow script with its metadata so it can be run again later by name (CreateWorkflow's `saved` source; ListSavedWorkflows lists them). The required `scope` decides whether it lives in this project or globally.",
  "",
  "NEVER call this tool unsolicited: saving writes a file into the user's repository, and that is their decision. When a workflow you just built looks reusable, suggest saving it in one sentence and wait; call SaveWorkflow only after the user agrees, or when the user asks directly.",
  "",
  "Load the `dynamic-workflows` skill with the Skill tool first: it carries the file format, the argument declarations and the authoring rules. The call is refused until that skill has been loaded in this session. Pass `script` (the body only) or `script_path` (a draft file, saved without re-emitting it), never both.",
].join("\n");
