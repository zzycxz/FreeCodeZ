// ============================================================
// 第四批 22①（升级实施手册）：被拒权限计数聚合
// ============================================================
// 数据源=流事件 executor/events.ts 的权限请求（手册：数据已在流事件只差聚合）。
// 本模块纯计数器：消费 PermissionDialog 的 onRespond 调用——decision === "deny"
// 时 +1；按 taskId 维度计数；UI 消费（状态面板/任务卡）。
// 纯函数（无 React/无副作用）——钉测试。

export interface PermissionDenialCounter {
  readonly byTask: ReadonlyMap<string, number>;
  readonly total: number;
}

export function createPermissionDenialCounter(): PermissionDenialCounter & {
  record(taskId: string, decision: string): PermissionDenialCounter;
  reset(): void;
} {
  let byTask = new Map<string, number>();
  return {
    get byTask() {
      return new Map(byTask);
    },
    get total() {
      let sum = 0;
      for (const count of byTask.values()) sum += count;
      return sum;
    },
    record(taskId: string, decision: string): PermissionDenialCounter {
      if (decision !== "deny") return this;
      byTask.set(taskId, (byTask.get(taskId) ?? 0) + 1);
      return this;
    },
    reset() {
      byTask = new Map();
    },
  };
}

/** 计数 → UI 文案参数。 */
export function denialDisplayData(counter: PermissionDenialCounter, taskId: string): {
  count: number;
  show: boolean;
} {
  const count = counter.byTask.get(taskId) ?? 0;
  return { count, show: count > 0 };
}
