// 上游 3.14.3 的指针化描述（R2）：snippet facade 与规则在 `dynamic-workflows` 技能里；
// 技能未加载时 resolveInput 以 428 拒收（见 dynamic-workflow-skill-gate.ts）。
// 文案逐字取自官方 3.14.3 装配（Bbo）。

export const EVAL_WORKFLOW_SNIPPET_TOOL_DESCRIPTION = [
  "Compile and run a small dynamic-workflow TypeScript snippet synchronously, against the same compiler, sandbox and world-read execution path a real run uses. It is the test bench for workflow authoring: check a parser against real command output, see what a glob actually returns, or exercise a gate predicate on real repository state before putting it in a CreateWorkflow script. No agent()/report(); nothing persists; the result comes back in this call.",
  "",
  "Load the `dynamic-workflows` skill with the Skill tool first: it carries the snippet facade and the rules. The call is refused until that skill has been loaded in this session. Pass `code` (inline) or `path` (a file holding the snippet), never both.",
].join("\n");
