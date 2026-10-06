// ============================================================
// 第四批 22③（升级实施手册）：终端 cwd 联动——renderer 投影 store 桥接
// ============================================================
// 手册 v3.3 方案：bash 工具在 agent 子进程，终端 tab 是 Host 侧 node-pty——
// 跨进程按 cwd/workspaceKey 匹配+投影 store 桥接。
// 本 hook = 桥接层：监听流事件（bash 工具调用），按 matchTerminalForAgent 匹配
// 终端 tab，将匹配结果写入 Zustand store 供终端 tab 高亮/badge 消费。
// 消费方在 Terminal.tsx 或 WorkspaceHeader 挂 hook 即可。

import { useEffect, useState } from "react";
import {
  matchTerminalForAgent,
  terminalWorkspaceKey,
  type TerminalTabIdentity,
} from "@zcode/shared";

export interface TerminalLinkEvent {
  /** 触发联动的 bash 工具调用（agent 子进程）。 */
  toolCallId: string;
  /** agent 会话的 workspace 路径/身份。 */
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface TerminalLinkMatch {
  /** 匹配到的终端 tab workspaceKey（null=不中不联动）。 */
  terminalWorkspaceKey: string | null;
  /** 最近一次联动事件 id（高亮去重用）。 */
  lastEventId: string | null;
}

/**
 * 终端 cwd 联动桥接 hook：消费 agent bash 调用事件→匹配终端 tab→投影到 store。
 * 
 * @param tabs 当前打开的终端 tab 清单（workspaceKey+cwd——由 Terminal.tsx 维护）
 * @param events agent 侧 bash 调用事件流（由流事件投影层推送；本 hook 只消费）
 */
export function useTerminalCwdLink(
  tabs: readonly TerminalTabIdentity[],
  events: readonly TerminalLinkEvent[],
): TerminalLinkMatch {
  const [match, setMatch] = useState<TerminalLinkMatch>({
    terminalWorkspaceKey: null,
    lastEventId: null,
  });

  const lastEvent = events[events.length - 1];
  const lastEventId = lastEvent?.toolCallId ?? null;

  useEffect(() => {
    if (!lastEvent) return;
    const result = matchTerminalForAgent(lastEvent, tabs);
    setMatch({
      terminalWorkspaceKey: result.matched ? result.tab.workspaceKey : null,
      lastEventId: lastEvent.toolCallId,
    });
  }, [lastEventId, lastEvent, tabs]);

  return match;
}

/** 便捷：tabs 数组→workspaceKey 数组（Terminal.tsx 的 key 列表投影）。 */
export function terminalTabKeys(tabs: readonly TerminalTabIdentity[]): string[] {
  return tabs.map(terminalWorkspaceKey);
}
