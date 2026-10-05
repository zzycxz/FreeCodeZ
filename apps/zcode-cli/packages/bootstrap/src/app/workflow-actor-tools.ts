// ============================================================
// workflow actor 的工具面（AgentRuntime 工具配置）
// ============================================================
//
// 0C-1③（升级实施手册）：减法黑名单转白名单。减法的前提是"全集可控"，但 MCP / plugin
// 工具是动态注册的（mcp__* / plugin:*），减法表永远盖不到——actor（无人值守、恒 yolo）
// 由此拿到全量第三方工具面。白名单结构性排除一切非内建动态工具。
//
// 内建清单与旧减法语义**等价**：旧的减法表移除项（交互/编排/越权元工具）不进白名单，
// 其余内建全保留——零行为收窄，唯一被排除的是动态工具与自动化/编排面。
// submit_result / escalate 不在白名单里：它们由端口门注册（includeSubmitResult /
// includeEscalate），且在 core 的 appendChildControlTool 对 workflow_child 无条件补回
// （注册面的 allowedTools 过滤不区分来源，控制通道不能被脚本声明面挤掉——与
// RespondToCoordinator 对 subagent_child 的补回同一条论证）。

import {
  ESCALATE_TOOL_NAME,
  SUBMIT_RESULT_TOOL_NAME,
} from "@zcode/contracts";

/** AgentRuntimeConfig 的工具面切片（0C-1③ 起为白名单）。 */
export interface WorkflowActorToolPolicy {
  toolAllowlist: readonly string[];
}

/**
 * actor 的工作工具白名单：文件/代码、执行、搜索与网络、任务管理、只读 run 内省。
 * 结构性排除：交互工具（悬挂）、编排工具（递归）、ReadSessionContext（越权）、
 * 自动化面（cron/off-peak）、以及一切 MCP/plugin 动态工具。
 */
export const ACTOR_ALLOWED_TOOLS: readonly string[] = [
  // 文件与代码
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  // 执行与内建 REPL
  "Bash",
  "js",
  // 搜索与网络
  "WebSearch",
  "WebFetch",
  "ImageSearch",
  "ImageUnderstand",
  "ViewImage",
  // 任务管理
  "TodoWrite",
  "TodoRead",
  "Agent",
  "SendMessage",
  "TaskOutput",
  "TaskStop",
  // 元工具与 run 内省（只读面；EvalWorkflowSnippet 是瞬态编译通道，旧减法未移除）
  "Skill",
  "ListModels",
  "GetWorkflowRun",
  "ListWorkflowRuns",
  "ListSavedWorkflows",
  "EvalWorkflowSnippet",
  // workflow 生命周期通道：不进声明面的交集（appendChildControlTool 无条件补回），
  // 在此列出仅供消费方枚举与测试对账。
  SUBMIT_RESULT_TOOL_NAME,
  ESCALATE_TOOL_NAME,
];

/**
 * workflow actor 的 AgentRuntime 工具配置。纯函数，供 driver 侧 runtime 工厂展开进
 * AgentRuntimeConfig：白名单 = 内建工作面；脚本声明的 opts.tools 在
 * script-workflow-child-runtime 与本白名单取交集（声明只能在白名单内**收窄**）。
 */
export function workflowActorToolPolicy(): WorkflowActorToolPolicy {
  return { toolAllowlist: ACTOR_ALLOWED_TOOLS };
}
