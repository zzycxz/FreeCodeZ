// FreeCodeZ W-26：动作面用户活动闸（FC 原创纯函数自 zcode-cua/macos/user-activity-gate.js
// 平移——该件为 FC 自有资产，随旧执行层删除后按 W-26 重生于桥层；语义等价）。
// 规格："用户动真鼠标 → 暂停 → 等静默后才续跑（防误操作）"。执行侧语义：
//   - 每个动作方法执行前等待用户静默；
//   - 持续活跃超过 maxWaitMs → fail-closed 结构化 user_active（可重试，不熔断）；
//   - 检测器缺席（lastMoveMs undefined）→ 放行：干预面缺席不折断动作本体。

export interface UserActivityReading {
  userActive?: boolean;
  /** 距上次鼠标移动的毫秒数；undefined=检测器缺席。 */
  lastMoveMs?: number;
}

export type UserActivityReader = () => UserActivityReading;

export interface UserActivityGateOptions {
  thresholdMs: number;
  pollMs?: number;
  maxWaitMs?: number;
}

/** 闸门缺省参数：静默阈值 800ms（与 HUD 层同义——两处"用户活跃"必须同值，防漂移）。 */
export const USER_ACTIVITY_GATE_DEFAULTS = {
  thresholdMs: 800,
  pollMs: 100,
  maxWaitMs: 30_000,
};

/**
 * 纯判定：一轮观测后闸门该做什么。
 *   proceed —— 已静默（或检测器缺席）→ 放行；
 *   wait    —— 用户活跃且未等满 → 下一轮；
 *   fail    —— 用户持续活跃等到上限 → 结构化失败。
 */
export function userActivityGateDecision(
  lastMoveMs: number | undefined,
  waitedMs: number,
  options: Pick<UserActivityGateOptions, "thresholdMs" | "maxWaitMs">,
): "proceed" | "wait" | "fail" {
  const { thresholdMs, maxWaitMs } = options;
  if (lastMoveMs === undefined) return "proceed";
  if (lastMoveMs >= thresholdMs) return "proceed";
  if (waitedMs >= maxWaitMs) return "fail";
  return "wait";
}

export type UserActivityGateResult =
  | { ok: true }
  | {
      ok: false;
      error: {
        code: "user_active";
        message: string;
        details: { waited_ms: number; last_move_ms: number | undefined };
      };
    };

/** 等待用户静默（异步轮询，readActivity 可注入供测试）。 */
export async function waitForUserQuiet(
  readActivity: UserActivityReader,
  options: Partial<UserActivityGateOptions> = {},
): Promise<UserActivityGateResult> {
  const opts = { ...USER_ACTIVITY_GATE_DEFAULTS, ...options };
  const startedAt = Date.now();
  for (;;) {
    const { lastMoveMs } = readActivity();
    const decision = userActivityGateDecision(lastMoveMs, Date.now() - startedAt, opts);
    if (decision === "proceed") return { ok: true };
    if (decision === "fail") {
      return {
        ok: false,
        error: {
          code: "user_active",
          message: "user is actively using the mouse; retry after the user goes quiet",
          details: { waited_ms: Date.now() - startedAt, last_move_ms: lastMoveMs },
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs));
  }
}

/**
 * 装饰器：按名单给动作方法套闸。名单中不存在的键跳过不注入；
 * 闸门失败不执行本体并返回结构化错误；放行透传参数与结果。
 */
export function wrapMethodsWithActivityGate<T extends Record<string, unknown>>(
  methods: T,
  names: readonly string[],
  readActivity: UserActivityReader,
  options: Partial<UserActivityGateOptions> = {},
): void {
  for (const name of names) {
    const original = methods[name];
    if (typeof original !== "function") continue;
    methods[name] = async (...args: unknown[]) => {
      const gate = await waitForUserQuiet(readActivity, options);
      if (!gate.ok) return gate;
      return (original as (...a: unknown[]) => unknown)(...args);
    };
  }
}

/** 读取器工厂：检测器缺席（无 bindings/非 darwin）→ 缺席形态（恒放行）。 */
export function createUserActivityReader(
  detector: UserActivityReader | undefined,
): UserActivityReader {
  if (!detector) {
    return () => ({ userActive: false, lastMoveMs: undefined });
  }
  return detector;
}
