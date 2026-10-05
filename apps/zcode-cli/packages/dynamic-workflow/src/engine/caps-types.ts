// Caps 的类型面（0C-1② 从 types.ts 拆出——types 已抵 400 行门；实现在 caps.ts）。

/**
 * run 级别的容量上限，submit 时固定并存入 dwf_run；当前只有并发上界，
 * 取消是唯一的控制面。maxActors（0C-1②）：run 级 actor 数量上限——actor 是完整
 * 子代理会话，调度器只挡派发不挡创建；缺省 DEFAULT_MAX_ACTORS（见 caps.ts），
 * 不持久化——resume 重放同样受缺省上限约束。
 */
export interface Caps {
  maxConcurrency: number;
  maxActors?: number;
}
