// 绑定码（附录B §1.5 bind / 决策 R3）：randomBytes(3) 6 位大写 HEX、默认 TTL 30s（ttlMs 可配）、
// 内存一次性（核销后立即失效）、仅私聊 `/bind <CODE>` 使用；code 大小写不敏感（核销按 upper 匹配）。
import { randomBytes } from "node:crypto";

export const DEFAULT_BIND_CODE_TTL_MS = 30_000;

export interface BindCodeRecord {
  code: string;
  botId: string;
  /** 绑定成功后写入 bot.allowedWorkspaces 的授权范围；缺省=全部。 */
  allowedWorkspaces?: string[];
  expiresAt: number;
}

export interface CreateBindCodeParams {
  botId: string;
  ttlMs?: number;
  allowedWorkspaces?: string[];
  now?: () => number;
}

export class BindCodeStore {
  private readonly codes = new Map<string, BindCodeRecord>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  create(params: CreateBindCodeParams): BindCodeRecord {
    this.sweepExpired();
    // 极小概率撞码时重生成，保证 Map 内 code 唯一
    let code = "";
    do {
      code = randomBytes(3).toString("hex").toUpperCase();
    } while (this.codes.has(code));
    const ttl = params.ttlMs !== undefined && params.ttlMs > 0 ? params.ttlMs : DEFAULT_BIND_CODE_TTL_MS;
    const record: BindCodeRecord = {
      code,
      botId: params.botId,
      ...(params.allowedWorkspaces ? { allowedWorkspaces: params.allowedWorkspaces } : {}),
      expiresAt: this.now() + ttl,
    };
    this.codes.set(code, record);
    return record;
  }

  /** 一次性核销：命中且未过期且 botId 匹配才返回记录并删除（官方仅成功后 r.delete）；否则 null。 */
  consume(code: string, botId: string): BindCodeRecord | null {
    const key = code.trim().toUpperCase();
    const record = this.codes.get(key);
    if (!record) return null;
    if (record.expiresAt <= this.now() || record.botId !== botId) return null;
    this.codes.delete(key);
    return record;
  }

  /** 只读查询（诊断用）；不核销。 */
  peek(code: string): BindCodeRecord | undefined {
    const record = this.codes.get(code.trim().toUpperCase());
    return record && record.expiresAt > this.now() ? record : undefined;
  }

  clearBot(botId: string): void {
    for (const [code, record] of this.codes) {
      if (record.botId === botId) this.codes.delete(code);
    }
  }

  clear(): void {
    this.codes.clear();
  }

  private sweepExpired(): void {
    const nowMs = this.now();
    for (const [code, record] of this.codes) {
      if (record.expiresAt <= nowMs) this.codes.delete(code);
    }
  }
}
