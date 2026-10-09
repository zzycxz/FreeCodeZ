// FreeCodeZ 平移件（R10①档）：CUA 操作 turn tracker——W-29"指示器事件源=turn tracker
// （tool-scheduled 判定）平移"。自 services/zcode-agent/cuaOperationTurnTracker.ts
// （历史 2e9870e^）平移；事件面改本地 tool 生命周期形状（旧 wire 类型已随 W-06/shared
// 收口删除），"是否 CUA"判定改工具名前缀（schedule-then-confirm 语义保留：tool-scheduled
// 判定排期、tool-started 兑现亮灯），PiP 生命周期段按 D5 不移植（PiP 不启动）。
import { resolveWorkspaceKey } from "@zcode/shared";

export interface CuaOperationWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface CuaOperationState {
  active: boolean;
  sessionId: string;
  turnId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface CuaOperationStateReporter {
  onStateChanged(event: CuaOperationState): void;
}

/** 本地 tool 生命周期事件面（旧 ZCodeComputerUseOperationEvent 的语义等价子集）。 */
export type CuaToolLifecycleEvent =
  | {
      kind: "turn-started";
      eventId: string;
      sequenceNumber: number;
      sessionId: string;
      turnId: string;
    }
  | {
      kind: "turn-completed" | "turn-failed";
      eventId: string;
      sequenceNumber: number;
      sessionId: string;
      turnId: string;
    }
  | {
      kind: "tool-scheduled";
      eventId: string;
      sequenceNumber: number;
      sessionId: string;
      turnId?: string;
      toolCallId: string;
      toolName: string;
    }
  | {
      kind: "tool-started";
      eventId: string;
      sequenceNumber: number;
      sessionId: string;
      turnId?: string;
      toolCallId: string;
    }
  | { kind: "session-closed"; eventId: string; sequenceNumber: number; sessionId: string };

/** computer-use 工具名族（新旧前缀都认——历史事件与新注册面同一判定）。 */
const COMPUTER_USE_TOOL_PREFIXES = [
  "mcp__computer-use__",
  "mcp__computer_use__",
  "mcp__plugin_freecodez_computer-use__",
] as const;

export function isComputerUseToolName(toolName: string): boolean {
  return COMPUTER_USE_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

interface CuaOperationTurnTracker {
  accept(workspace: CuaOperationWorkspaceTarget, event: CuaToolLifecycleEvent): void;
  hasActiveTurn(): boolean;
  clearWorkspaceKey(workspaceKey: string): void;
  clearAll(): void;
}

interface TrackerLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

interface ActiveTurnRecord extends CuaOperationState {
  workspaceKey: string;
  sessionKey: string;
  turnKey: string;
}

const MAX_RETIRED_TURN_KEYS = 2_048;
const MAX_SEEN_OPERATION_EVENT_IDS = 8_192;

function toReportedState(record: ActiveTurnRecord, active: boolean): CuaOperationState {
  return {
    active,
    sessionId: record.sessionId,
    turnId: record.turnId,
    workspacePath: record.workspacePath,
    ...(record.workspaceIdentity ? { workspaceIdentity: record.workspaceIdentity } : {}),
  };
}

export function createCuaOperationTurnTracker(options: {
  /** Windows 顶部提示条/指示器的桌面投影。 */
  reporter?: CuaOperationStateReporter;
  onTurnsActive?: () => void;
  onTurnsIdle?: () => void;
  logger?: TrackerLogger;
}): CuaOperationTurnTracker {
  const currentTurnBySession = new Map<string, string>();
  const lastSeqBySession = new Map<string, number>();
  // 排期时判定（tool-scheduled 携带工具名），tool-started 兑现——排期与开始之间可能
  // 卡在权限审批，那时还没有人在操作电脑。
  const computerUseScheduledCalls = new Set<string>();
  const activeTurns = new Map<string, ActiveTurnRecord>();
  const retiredTurnKeys = new Set<string>();
  const retiredTurnKeyOrder: string[] = [];
  const seenEventIds = new Set<string>();
  const seenEventIdOrder: string[] = [];

  const sessionKeyFor = (workspaceKey: string, sessionId: string) =>
    `${workspaceKey}\0${sessionId}`;
  const turnKeyFor = (sessionKey: string, turnId: string) => `${sessionKey}\0${turnId}`;
  const toolKeyFor = (turnKey: string, toolCallId: string) => `${turnKey}\0${toolCallId}`;

  function notifyBoundary(kind: "active" | "idle"): void {
    const callback = kind === "active" ? options.onTurnsActive : options.onTurnsIdle;
    if (!callback) return;
    options.logger?.info(
      `computer-use operation turns ${kind === "active" ? "became active" : "went idle"} (activeTurns=${activeTurns.size})`,
    );
    try {
      callback();
    } catch (error) {
      options.logger?.warn(`turn boundary callback failed error=${String(error)}`);
    }
  }

  function report(record: ActiveTurnRecord, active: boolean, refresh = false): void {
    if (options.reporter) {
      try {
        options.reporter.onStateChanged(toReportedState(record, active));
      } catch (error) {
        // Reporter 是桌面投影旁路；不能截断主事件链路。
        options.logger?.warn(
          `operation reporter failed workspace=${record.workspaceKey} session=${record.sessionId} turn=${record.turnId} error=${String(error)}`,
        );
      }
    }
    if (refresh) {
      options.logger?.debug(`operation turn refreshed workspace=${record.workspaceKey}`);
    } else {
      options.logger?.info(
        `operation turn ${active ? "activated" : "cleared"} workspace=${record.workspaceKey} session=${record.sessionId} turn=${record.turnId}`,
      );
    }
  }

  function retireTurn(turnKey: string): void {
    if (retiredTurnKeys.has(turnKey)) return;
    retiredTurnKeys.add(turnKey);
    retiredTurnKeyOrder.push(turnKey);
    while (retiredTurnKeyOrder.length > MAX_RETIRED_TURN_KEYS) {
      const removed = retiredTurnKeyOrder.shift();
      if (removed) retiredTurnKeys.delete(removed);
    }
  }

  function clearTurn(turnKey: string): void {
    const record = activeTurns.get(turnKey);
    if (record) {
      activeTurns.delete(turnKey);
      report(record, false);
    }
    const toolPrefix = `${turnKey}\0`;
    for (const key of computerUseScheduledCalls) {
      if (key.startsWith(toolPrefix)) computerUseScheduledCalls.delete(key);
    }
    if (record && activeTurns.size === 0) notifyBoundary("idle");
  }

  function clearSession(sessionKey: string): void {
    for (const record of activeTurns.values()) {
      if (record.sessionKey === sessionKey) clearTurn(record.turnKey);
    }
    const sessionPrefix = `${sessionKey}\0`;
    for (const key of computerUseScheduledCalls) {
      if (key.startsWith(sessionPrefix)) computerUseScheduledCalls.delete(key);
    }
  }

  function accept(
    workspace: CuaOperationWorkspaceTarget,
    event: CuaToolLifecycleEvent,
  ): void {
    const workspaceKey = resolveWorkspaceKey(workspace);
    const sessionKey = sessionKeyFor(workspaceKey, event.sessionId);
    const eventKey = `${workspaceKey}\0${event.eventId}`;
    if (seenEventIds.has(eventKey)) return;
    seenEventIds.add(eventKey);
    seenEventIdOrder.push(eventKey);
    while (seenEventIdOrder.length > MAX_SEEN_OPERATION_EVENT_IDS) {
      const removed = seenEventIdOrder.shift();
      if (removed) seenEventIds.delete(removed);
    }

    const lastSeq = lastSeqBySession.get(sessionKey) ?? 0;
    if (event.sequenceNumber < lastSeq) return;
    lastSeqBySession.set(sessionKey, Math.max(lastSeq, event.sequenceNumber));

    if (event.kind === "turn-started") {
      const nextTurnKey = turnKeyFor(sessionKey, event.turnId);
      if (retiredTurnKeys.has(nextTurnKey)) return;
      const previousTurnId = currentTurnBySession.get(sessionKey);
      if (previousTurnId && previousTurnId !== event.turnId) {
        retireTurn(turnKeyFor(sessionKey, previousTurnId));
        clearSession(sessionKey);
      }
      currentTurnBySession.set(sessionKey, event.turnId);
      return;
    }

    if (event.kind === "session-closed") {
      const currentTurnId = currentTurnBySession.get(sessionKey);
      if (currentTurnId) retireTurn(turnKeyFor(sessionKey, currentTurnId));
      clearSession(sessionKey);
      currentTurnBySession.delete(sessionKey);
      return;
    }

    if (event.kind === "turn-completed" || event.kind === "turn-failed") {
      const turnKey = turnKeyFor(sessionKey, event.turnId);
      retireTurn(turnKey);
      clearTurn(turnKey);
      if (currentTurnBySession.get(sessionKey) === event.turnId) {
        currentTurnBySession.delete(sessionKey);
      }
      return;
    }

    if (event.kind !== "tool-scheduled" && event.kind !== "tool-started") return;
    const toolCallId = event.toolCallId;
    const currentTurnId = currentTurnBySession.get(sessionKey);
    const turnId = event.turnId ?? currentTurnId;
    if (!toolCallId || !turnId) return;
    // 新 turn 替换旧 turn 后，迟到的旧 tool event 不能复活已终止的提示。
    if (currentTurnId && turnId !== currentTurnId) return;
    if (!currentTurnId) currentTurnBySession.set(sessionKey, turnId);

    const turnKey = turnKeyFor(sessionKey, turnId);
    if (retiredTurnKeys.has(turnKey)) return;
    const toolKey = toolKeyFor(turnKey, toolCallId);
    if (event.kind === "tool-scheduled") {
      if (isComputerUseToolName(event.toolName)) computerUseScheduledCalls.add(toolKey);
      return;
    }

    // tool-started 兑现：只认"这次 tool call 在用 computer-use 工具"这一个事实。
    if (!computerUseScheduledCalls.delete(toolKey)) return;

    const existingRecord = activeTurns.get(turnKey);
    if (existingRecord) {
      report(existingRecord, true, true);
      return;
    }

    const record: ActiveTurnRecord = {
      active: true,
      workspaceKey,
      sessionKey,
      turnKey,
      sessionId: event.sessionId,
      turnId,
      workspacePath: workspace.workspacePath,
      ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
    };
    activeTurns.set(turnKey, record);
    report(record, true);
    if (activeTurns.size === 1) notifyBoundary("active");
  }

  function clearWorkspaceKey(workspaceKey: string): void {
    for (const record of activeTurns.values()) {
      if (record.workspaceKey === workspaceKey) clearTurn(record.turnKey);
    }
    const workspacePrefix = `${workspaceKey}\0`;
    for (const map of [currentTurnBySession, lastSeqBySession]) {
      for (const key of map.keys()) {
        if (key.startsWith(workspacePrefix)) map.delete(key);
      }
    }
    for (const key of computerUseScheduledCalls) {
      if (key.startsWith(workspacePrefix)) computerUseScheduledCalls.delete(key);
    }
    for (let index = retiredTurnKeyOrder.length - 1; index >= 0; index -= 1) {
      const key = retiredTurnKeyOrder[index];
      if (!key?.startsWith(workspacePrefix)) continue;
      retiredTurnKeyOrder.splice(index, 1);
      retiredTurnKeys.delete(key);
    }
    for (let index = seenEventIdOrder.length - 1; index >= 0; index -= 1) {
      const key = seenEventIdOrder[index];
      if (!key?.startsWith(workspacePrefix)) continue;
      seenEventIdOrder.splice(index, 1);
      seenEventIds.delete(key);
    }
  }

  function clearAll(): void {
    for (const record of activeTurns.values()) clearTurn(record.turnKey);
    currentTurnBySession.clear();
    lastSeqBySession.clear();
    computerUseScheduledCalls.clear();
    retiredTurnKeys.clear();
    retiredTurnKeyOrder.length = 0;
    seenEventIds.clear();
    seenEventIdOrder.length = 0;
  }

  return { accept, hasActiveTurn: () => activeTurns.size > 0, clearWorkspaceKey, clearAll };
}
