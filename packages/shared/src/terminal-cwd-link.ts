// ============================================================
// 第四批 22③（升级实施手册）：终端 cwd 联动——投影匹配纯件
// ============================================================
// 方案（手册 v3.3 前提修正）：bash 工具在 agent 子进程，终端 tab 是 Host 侧
// node-pty——不同进程不能直接桥。方案=按 cwd/workspaceKey 匹配+投影 store 桥接。
// 本模块 = 匹配纯件（无副作用、可测）：agent 会话的 cwd/identity → 命中哪个终端 tab。
// 消费方（renderer 投影 store 桥接层）由 UI 批接线。

export interface TerminalTabIdentity {
  workspaceKey: string;
  cwd: string;
}

export interface AgentSessionIdentity {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * 终端 tab 的 workspace 键（与 Terminal.tsx 同口径：
 * workspaceIdentity?.trim() || cwd || "__default__"）。
 */
export function terminalWorkspaceKey(tab: TerminalTabIdentity): string {
  return tab.workspaceKey.trim() || tab.cwd.trim() || "__default__";
}

/**
 * agent 会话的 workspace 键（与 AGENTS.md 身份键统一口径：
 * workspaceIdentity?.trim() || workspacePath）。
 */
export function agentWorkspaceKey(session: AgentSessionIdentity): string {
  return session.workspaceIdentity?.trim() || session.workspacePath;
}

export type TerminalMatchResult =
  | { matched: true; workspaceKey: string; tab: TerminalTabIdentity }
  | { matched: false; reason: "no_tabs" | "identity_mismatch" | "cwd_prefix_mismatch" };

/**
 * 匹配：identity 键精确匹配优先；无 identity 时按 cwd 前缀（agent cwd 是终端 cwd
 * 或其子目录——如 agent cd 进了 project/sub）。两道都不中=不联动。
 */
export function matchTerminalForAgent(
  session: AgentSessionIdentity,
  tabs: readonly TerminalTabIdentity[],
): TerminalMatchResult {
  if (tabs.length === 0) return { matched: false, reason: "no_tabs" };
  const key = agentWorkspaceKey(session);
  const exact = tabs.find((tab) => terminalWorkspaceKey(tab) === key);
  if (exact) return { matched: true, workspaceKey: key, tab: exact };
  // cwd 前缀匹配（agent cwd 以 tab cwd 开头）
  const prefix = tabs.find((tab) => {
    const tabCwd = tab.cwd.replace(/\/+$/, "");
    const agentCwd = session.workspacePath.replace(/\/+$/, "");
    return tabCwd !== "" && (agentCwd === tabCwd || agentCwd.startsWith(`${tabCwd}/`));
  });
  if (prefix) return { matched: true, workspaceKey: key, tab: prefix };
  return { matched: false, reason: "identity_mismatch" };
}
