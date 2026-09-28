// 任务级资源登记表（决策 R13）：botId → 运行中订阅/typing/transient 卡/pending 登记。
// 覆盖：任务流订阅、typing interval、飞书 transient 交互卡句柄（dispose→DELETE 撤回）、
// pending selection / pending elicitation（scope 维度单条登记）。官方在 bot 删除/停用/重置时
// 残留订阅与 typing 定时器；这里统一登记，三路径（deleteBot / resetBotState / 停用）
// 调 releaseBotResources 收口，杜绝外发残留。

export interface BotResourceHandles {
  /** 任务流订阅退订句柄（watchTaskStream onDynamicTaskEvent）。 */
  unsubscribe?: () => void;
  /** typing 心跳停止句柄。 */
  stopTyping?: () => void;
  /** 其他需要在 bot 生命周期结束时释放的句柄（transient 卡 DELETE 撤回 / pending 清理）。 */
  dispose?: () => void | Promise<void>;
}

interface RegisteredResource {
  botId: string;
  taskId?: string;
  handles: BotResourceHandles;
}

export class BotResourceRegistry {
  private readonly entries = new Map<number, RegisteredResource>();
  /** scopeKey（如 selection/elicitation/transient 卡）→ 登记 id；同 scope 复用一条登记。 */
  private readonly scopedIds = new Map<string, number>();
  private nextId = 1;

  register(botId: string, handles: BotResourceHandles, taskId?: string): number {
    const id = this.nextId++;
    this.entries.set(id, { botId, handles, ...(taskId ? { taskId } : {}) });
    return id;
  }

  /**
   * scope 维度登记（pending selection / pending elicitation / transient 卡）：
   * 同 `botId::scopeKey` 只保留一条，替换时旧句柄先释放（dispose 自带比对守卫则无副作用）。
   */
  registerScoped(
    botId: string,
    scopeKey: string,
    handles: BotResourceHandles,
    taskId?: string,
  ): number {
    const key = `${botId}::${scopeKey}`;
    const previous = this.scopedIds.get(key);
    if (previous !== undefined) this.release(previous);
    const userDispose = handles.dispose;
    const id = this.register(
      botId,
      {
        ...handles,
        dispose: () => {
          if (this.scopedIds.get(key) === id) this.scopedIds.delete(key);
          return userDispose?.();
        },
      },
      taskId,
    );
    this.scopedIds.set(key, id);
    return id;
  }

  /** scope 维度自注销（pending selection 被消费/清空、elicitation 正常收口时）。 */
  releaseScoped(botId: string, scopeKey: string): void {
    const key = `${botId}::${scopeKey}`;
    const id = this.scopedIds.get(key);
    if (id === undefined) return;
    this.scopedIds.delete(key);
    this.release(id);
  }

  /** 单个资源完成（如任务流自然收口）后的自注销。 */
  release(id: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    runRelease(entry.handles);
  }

  /** 三路径统一释放：deleteBot / resetBotState / 停用。 */
  releaseBotResources(botId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.botId !== botId) continue;
      this.entries.delete(id);
      runRelease(entry.handles);
    }
  }

  /** 任务维度释放（任务被替换/删除时）。 */
  releaseTaskResources(botId: string, taskId: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.botId !== botId || entry.taskId !== taskId) continue;
      this.entries.delete(id);
      runRelease(entry.handles);
    }
  }

  list(botId?: string): Array<{ id: number; botId: string; taskId?: string }> {
    const rows: Array<{ id: number; botId: string; taskId?: string }> = [];
    for (const [id, entry] of this.entries) {
      if (botId && entry.botId !== botId) continue;
      rows.push({ id, botId: entry.botId, ...(entry.taskId ? { taskId: entry.taskId } : {}) });
    }
    return rows;
  }

  releaseAll(): void {
    for (const [id, entry] of this.entries) {
      this.entries.delete(id);
      runRelease(entry.handles);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

function runRelease(handles: BotResourceHandles): void {
  try {
    handles.stopTyping?.();
  } catch {
    // best-effort：typing 停止失败不阻断订阅释放
  }
  try {
    handles.unsubscribe?.();
  } catch {
    // best-effort
  }
  try {
    void handles.dispose?.();
  } catch {
    // best-effort
  }
}
