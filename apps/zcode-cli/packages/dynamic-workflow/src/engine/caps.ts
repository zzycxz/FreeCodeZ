// ============================================================
// run 容量上限（0C-1②，升级实施手册）
// ============================================================
// 从 types.ts/engine.ts 拆出：两者都已抵 400 行门（run-terminal.ts 同款先例——
// 消费者按惯例仍从原文件经再导出取用）。调度器的 maxConcurrency 只压在飞 ask，
// 挡不住脚本先注册无限多 actor（每个都是完整子代理会话）；创建门在 engine.createActor。

import { WorkflowError } from "./types.js";
import type { Caps } from "./caps-types.js";

/** run 级 actor 数量缺省上限（Caps.maxActors 可覆盖）。护栏不是配额——容纳真实扇出。 */
export const DEFAULT_MAX_ACTORS = 128;

/** 解析生效上限（缺席用缺省）。 */
export function effectiveMaxActors(caps: Pick<Caps, "maxActors">): number {
  return caps.maxActors ?? DEFAULT_MAX_ACTORS;
}

/** 创建门判定：超限返回结构化错误（failRun + 同步抛由调用方执行），未超返回 undefined。 */
export function buildActorLimitError(actorCount: number, caps: Pick<Caps, "maxActors">): WorkflowError | undefined {
  const maxActors = effectiveMaxActors(caps);
  if (actorCount < maxActors) return undefined;
  return new WorkflowError(
    "ActorLimitExceeded",
    `This run already has ${actorCount} subagents and the cap is ${maxActors}. ` +
      `Each subagent is a full agent session; reuse existing subagents (loop over asks on the ` +
      `same actor) instead of creating more.`,
  );
}
