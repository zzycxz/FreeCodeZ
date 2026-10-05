/**
 * ask 调度器：把"每 actor FIFO + hold 规则 + 并发上限派发 + ask 结算"从引擎主体拆出，
 * 使两个文件都聚焦、可读（并满足单文件行数上限）。引擎通过 {@link SchedulerHost} 注入其
 * 依赖（driver、caps、序号分配、run 级失败），调度器只负责 ask 生命周期，不管 run 生命周期。
 *
 * 关键规则见 engine.ts 顶部说明：命中短路、actorSeq 准入顺序、replay 的 hold 规则、串行 actor。
 *
 * 内部类型与 SchedulerHost 在 scheduler-types.ts；submit / turn 的向上回报处理在 scheduler-submit.ts
 * （拆分原因：oxlint max-lines 上限 400 行）。SchedulerHost 在此原地再导出，导入路径不变。
 */

import { hashMismatch, inputHash } from "./hash.js";
import { importedAskRecord, type ImportedActorState } from "./imported-cache.js";
import { ReplaySettleOrder, recoverReplaySettleOrder } from "./scheduler-replay.js";
import { defer, type Actor, type AskNode, type Deferred, type SchedulerHost } from "./scheduler-types.js";
import { handleSubmitAttempted, handleTurnEnded, type SubmitSeam } from "./scheduler-submit.js";
import type {
  ActorId,
  ActorRef,
  AskMessage,
  AskSpec,
  AskStats,
  InstanceRef,
  JournalStorePort,
  NodeRecord,
  PersonaSpec,
  SessionRef,
} from "./types.js";
import {
  INSTRUCTIONS_HEAD_MAX_CHARS,
  NUDGE_ATTEMPTS,
  refToString,
  REPAIR_ATTEMPTS,
  WorkflowError,
} from "./types.js";

export type { SchedulerHost } from "./scheduler-types.js";

export class AskScheduler {
  private readonly actors = new Map<ActorId, Actor>();
  private readonly actorOrder: Actor[] = [];
  private readonly liveNodes = new Map<string, AskNode>();
  private activeAsks = 0;
  /**
   * 转录来自前代的 ask 实例（批次 2-2 carry：携带位命中、或崩溃恢复重放的 running 行）。
   * 它们的 stats 落 journal 时剥掉 `worldToolCalls`——缺键让**更后续**修订的 takeIfPure 把
   * 它按「碰过世界」处理，携带结果因此绝不进导入缓存（R4：不得免费复用）。
   */
  private readonly priorTranscriptAsks = new Set<string>();
  /** replay 缓存结算的放行序表（批次 2-2）；非 resume 恒空表（全部立即结算）。 */
  private replay = ReplaySettleOrder.empty();
  /** 关门之前已准入的 ask 集合（批次 2-2 携带判定的崩溃恢复输入）。 */
  private queuedBeforeImportClose: ReadonlySet<string> = new Set();

  /** scheduler-submit.ts 的自由函数经它查 live 节点、按结果结算（见 {@link SubmitSeam}）。 */
  private readonly submitSeam: SubmitSeam;

  constructor(private readonly host: SchedulerHost) {
    this.submitSeam = {
      host,
      liveNode: (instance) => this.liveNodes.get(refToString(instance)),
      settleOk: (node, artifact) => this.settleOk(node, artifact),
      settleFailed: (node, error) => this.settleFailed(node, error),
    };
  }

  private get journal(): JournalStorePort {
    return this.host.driver.journal;
  }

  hasActor(id: ActorId): boolean {
    return this.actors.has(id);
  }

  /** 0C-1②：已注册 actor 总数（创建门执法用）。 */
  actorCount(): number {
    return this.actors.size;
  }

  /**
   * 注册一个 actor（创建站点 × 序号）。`imported` 是 amend-resume 的导入候选：引擎已在
   * createActor 里按有效名 + 规范化 persona 匹配过，调度器只负责消费它。
   */
  registerActor(
    ref: ActorRef,
    id: ActorId,
    name: string | undefined,
    persona: PersonaSpec,
    imported?: ImportedActorState,
  ): Actor {
    const recordedCount = this.journal
      .listNodes(this.host.runId)
      .filter((n) => n.kind === "ask" && n.actorSiteId === ref.siteId && n.actorOrdinal === ref.ordinal).length;
    const actor: Actor = {
      ref,
      id,
      persona,
      name,
      recordedCount,
      nextAdmitSeq: 0,
      pendingRecorded: new Map(),
      pendingLive: [],
      liveQueue: [],
      ...(imported === undefined ? {} : { imported }),
    };
    // 不能把 journal 记录的 sessionId 预解析成 actor.session/sessionPromise：
    // 让 resume 后的 ensureSession 跳过 driver.createActorSession。但生产 driver 的会话表
    // **只**在 createActorSession 里填充，startAsk 按表查会话——于是 resume 重新派发的每个
    // ask 都以「未知会话」失败。纯 replay（零派发）与 fake driver（startAsk 不查表）都暴露
    // 不了它。会话身份本就归 driver 所有（生产铸造函数按 (runId, actorRef) 纯确定，重挂时
    // 铸出同一个 id）；journal 的 dwf_actor.session_id 是记录、不是权威，所以这里绝不从
    // journal 短路会话——首次派发一律走 driver.createActorSession（见 ensureSession）。
    this.actors.set(id, actor);
    this.actorOrder.push(actor);
    return actor;
  }

  /** 受理一次 ask：完结命中短路（走 hold 规则），running 命中或未命中则 live 派发。 */
  admitAsk(siteId: string, actorId: ActorId, instructions: string, spec: AskSpec): Promise<unknown> {
    const actor = this.actors.get(actorId)!;
    const ordinal = this.host.nextOrdinal(siteId);
    const instance: InstanceRef = { siteId, ordinal };
    const hash = inputHash(instructions);
    const deferred = defer<unknown>();

    const recorded = this.journal.getNode(this.host.runId, siteId, ordinal);
    if (recorded !== undefined) {
      // 命中即防御性校验 inputHash——不一致说明纯度契约被破坏，run 大声失败。
      if (recorded.inputHash !== hash) {
        const err = hashMismatch(instance, recorded.inputHash, hash);
        this.host.failRun(err);
        return Promise.reject(err);
      }
      const seq = recorded.actorSeq ?? 0;
      if (recorded.status === "running") {
        // 崩溃于执行中：按记录的 actorSeq 位置重新 live 派发（hold 规则保证其准入次序）。
        // priorTranscript=true：重放的 running 行在原次执行里已带着前代转录（携带 ask 的崩溃
        // 恢复形态），重派发必须保持这个身份，否则 stats 剥离的纯度约定在恢复后失守。
        actor.pendingRecorded.set(seq, () => {
          actor.imported?.reconcileRecorded(
            seq,
            recorded.inputHash,
            this.host.wasLiveBeforeResume(instance),
            this.queuedBeforeImportClose.has(refToString(instance)),
          );
          this.admitLive(instance, actor, seq, instructions, hash, spec, deferred, true);
        });
      } else {
        // completed / failed：短路结算，无 driver 调用；结算经 ReplaySettleOrder 按崩溃前
        // 落地序放行（批次 2-2），跨 ask 的观察序在恢复里因此保持确定。
        actor.pendingRecorded.set(seq, () => {
          actor.imported?.reconcileRecorded(
            seq,
            recorded.inputHash,
            this.host.wasLiveBeforeResume(instance),
            this.queuedBeforeImportClose.has(refToString(instance)),
          );
          this.releaseCachedAsk(instance, recorded, deferred);
        });
      }
      this.drainAdmission(actor);
      return deferred.promise;
    }

    // 未命中（fresh）：注册到 pendingLive，按到达顺序在记录节点排空后准入并分配新的 actorSeq。
    // 分配到 seq 之后先问导入缓存（amend-resume）：命中即 cached settle，不 live。不命中且
    // 分歧恰好落在前代在飞 ask 上（carriedAt）时，该 ask 带着 priorTranscript 身份转 live。
    actor.pendingLive.push(() => {
      const seq = actor.nextAdmitSeq++;
      if (this.tryImportedSettle(instance, actor, seq, hash, deferred)) return;
      const carried = actor.imported?.carriedAt(seq) === true;
      this.admitLive(instance, actor, seq, instructions, hash, spec, deferred, carried);
    });
    this.drainAdmission(actor);
    this.pumpAll();
    return deferred.promise;
  }

  /** 把一个 ask 作为 live 节点准入：建节点、准入即落 running 记录、入队并记事件。 */
  private admitLive(
    instance: InstanceRef,
    actor: Actor,
    seq: number,
    instructions: string,
    hash: string,
    spec: AskSpec,
    deferred: Deferred<unknown>,
    priorTranscript = false,
  ): void {
    if (priorTranscript) this.priorTranscriptAsks.add(refToString(instance));
    const node: AskNode = {
      instance,
      actor,
      actorSeq: seq,
      instructions,
      hash,
      spec,
      deferred,
      repairsRemaining: REPAIR_ATTEMPTS,
      nudgesRemaining: NUDGE_ATTEMPTS,
      settled: false,
      dispatched: false,
    };
    this.liveNodes.set(refToString(instance), node);
    // 准入即落 running（携 actorSeq + inputHash）：崩溃于执行中的节点 resume 可据此重新派发。
    this.journal.putNode({
      runId: this.host.runId,
      siteId: instance.siteId,
      ordinal: instance.ordinal,
      kind: "ask",
      actorSiteId: actor.ref.siteId,
      actorOrdinal: actor.ref.ordinal,
      actorSeq: seq,
      inputHash: hash,
      status: "running",
    });
    actor.liveQueue.push(node);
    // 指令开头随出生事件一起落轨：这里的 instructions 还是
    // 作者的原文——driver 的质量 / schema 尾注在 startAsk 里才追加，所以摘要里不会混进引擎的话。
    const instructionsHead = headOfInstructions(instructions);
    this.host.record({
      type: "node-queued",
      instance,
      kind: "ask",
      actor: actor.ref,
      actorSeq: seq,
      ...(instructionsHead === undefined ? {} : { instructionsHead }),
    });
    // 转 live **不**关导入缓存。曾经在这里关：任一 ask live
    // 即视为工作区可能被改写。那是拿时钟代替依赖——同一个 Promise.all 里排在第一个未命中之后的
    // 兄弟 ask 全被判失效，而它们之间没有任何依赖（实测 50 路扇出丢 6 个命中，5 路扇出
    // 丢掉唯一的 1 个）。现在关门的是**第一笔写入**：driver 在子代理即将执行改写工具时上报
    // askMutating，或一条 world.run live 执行；在此之前的世界与前驱留下的世界相同，缓存命中都成立。
  }

  /**
   * fresh ask 准入时问一次导入缓存（amend-resume）。命中即 **cached settle** 并返回 true
   * （调用方不再 live）；判定与分歧记账全在 {@link ImportedActorState}。
   *
   * 命中写一行**真** dwf_node，只发 `node-settled cached:true`——与 replay 命中的
   * {@link releaseCachedAsk} 同一副姿态：不发 node-queued / node-dispatched，
   * 不入 liveQueue，不建会话，不占 `actor.current`。
   */
  private tryImportedSettle(
    instance: InstanceRef,
    actor: Actor,
    seq: number,
    hash: string,
    deferred: Deferred<unknown>,
  ): boolean {
    // 缓存已关闭 ⇒ 只放**纯** ask（前驱记下 toolCalls === 0）：它只依赖指令与转录前缀，与工作区
    // 无关，所以对旧世界的答案对新世界同样成立；带工具的条目即便同哈希也转 live——它读过的
    // 工作区可能已被改写。转 live 的那个 ask 让该 actor 分歧（转录从此不同），已消费前缀仍是种子
    // 边界的依据。
    const entry = this.host.importCacheClosed()
      ? actor.imported?.takeIfPure(seq, hash)
      : actor.imported?.take(seq, hash);
    if (entry === undefined) return false;
    this.journal.putNode(importedAskRecord(this.host.runId, instance, actor.ref, seq, hash, entry));
    this.host.record({ type: "node-settled", instance, outcome: "ok", cached: true });
    deferred.resolve(entry.result);
    return true;
  }

  // ——————————————————————————————— 向上回报 ———————————————————————————————

  /** submit_result 到达：方法体在 scheduler-submit.ts 的 handleSubmitAttempted。 */
  submitAttempted(instance: InstanceRef, payload: unknown): void {
    handleSubmitAttempted(this.submitSeam, instance, payload);
  }

  /** turn 结束（无 submit）：方法体在 scheduler-submit.ts 的 handleTurnEnded。 */
  turnEnded(instance: InstanceRef, finalText: string): void {
    handleTurnEnded(this.submitSeam, instance, finalText);
  }

  noteStats(instance: InstanceRef, stats: AskStats): void {
    const node = this.liveNodes.get(refToString(instance));
    if (node !== undefined) {
      node.lastStats = stats;
      return;
    }
    // 节点已离开 liveNodes——typed-accept 主导路径：submit 停 turn 并在 settle 时落库，而真实
    // actor 的用量在 turn 解析后（submit 之后）才知道，故 stats 在结算之后才到达。回填已结算的
    // journal 记录：只新增/覆写 stats，保留 status/result/actorSeq/inputHash/error/kind/actor 身份。
    // 尽力而为且幂等；预算扣减仍在 engine.askStats（此处只补 journal 完整性）。
    const recorded = this.journal.getNode(this.host.runId, instance.siteId, instance.ordinal);
    if (recorded === undefined) return;
    this.journal.putNode({ ...recorded, stats });
  }

  failed(instance: InstanceRef, error: WorkflowError): void {
    const node = this.liveNodes.get(refToString(instance));
    if (node === undefined || node.settled) return;
    this.settleFailed(node, error);
  }

  /** 该实例是否仍是在飞（已准入、未结算）的 live ask——限流观察事件只对这样的节点有意义。 */
  isLive(instance: InstanceRef): boolean {
    const node = this.liveNodes.get(refToString(instance));
    return node !== undefined && !node.settled;
  }

  /** 在飞 ask 所属子代理的有效名（关门事件里点名用）；不在飞即 undefined。 */
  liveActorName(instance: InstanceRef): string | undefined {
    const node = this.liveNodes.get(refToString(instance));
    return node === undefined || node.settled ? undefined : node.actor.persona.name;
  }

  /** 中止所有在飞 ask：run 取消/失败时用。emitCancelled 为真时补发 node-settled(cancelled)。 */
  abortInFlight(error: WorkflowError, emitCancelled: boolean): void {
    for (const node of this.liveNodes.values()) {
      if (node.settled) continue;
      node.settled = true;
      if (node.dispatched) this.host.driver.cancelAsk(node.instance);
      if (emitCancelled) {
        this.host.record({ type: "node-settled", instance: node.instance, outcome: "cancelled" });
      }
      node.deferred.reject(error);
    }
    this.liveNodes.clear();
    this.activeAsks = 0;
  }

  // ——————————————————————————————— 内部：准入 / 派发 ———————————————————————————————

  private drainAdmission(actor: Actor): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const release = actor.pendingRecorded.get(actor.nextAdmitSeq);
      if (release !== undefined) {
        actor.pendingRecorded.delete(actor.nextAdmitSeq);
        actor.nextAdmitSeq++;
        release();
        progressed = true;
        continue;
      }
      if (actor.nextAdmitSeq >= actor.recordedCount && actor.pendingLive.length > 0) {
        const admit = actor.pendingLive.shift()!;
        admit();
        progressed = true;
      }
    }
    this.pumpActor(actor);
  }

  private releaseCachedAsk(instance: InstanceRef, recorded: NodeRecord, deferred: Deferred<unknown>): void {
    // ReplaySettleOrder（批次 2-2）：缓存行的 replay 结算按崩溃前的落地序放行——同 run 多个
    // 已完结行在恢复中并发短路时，事件序与原次执行一致，读面（投影/通知）不闪变。
    this.replay.hold(refToString(instance), () => {
      if (recorded.status === "completed") {
        this.host.record({ type: "node-settled", instance, outcome: "ok", cached: true });
        deferred.resolve(recorded.result);
      } else {
        // 已记录的失败也要短路复现：脚本可能已 try/catch 过它并据此分支，replay 必须重放同一 rejection。
        this.host.record({ type: "node-settled", instance, outcome: "failed", cached: true, error: recorded.error });
        deferred.reject(WorkflowError.fromJSON(recorded.error!));
      }
    });
  }

  /**
   * 泵全部 actor 的排队 ask。公开给引擎的升档 retune（原地调大 caps 后放行排队）与
   * 既有的内部时机共用；pumpActor 内部仍按 caps.maxConcurrency 门禁——降档后的在飞
   * 不回收，只挡后续派发。
   */
  pumpAll(): void {
    for (const actor of this.actorOrder) this.pumpActor(actor);
  }

  /**
   * resume 恢复（批次 2-2）：重建 replay 放行序表，并收下「关门之前已准入」集合（引擎在
   * resume 分支做一次 recoverImportClosure，把两样东西一并递进来，不二次扫描事件）。
   */
  recoverReplayState(queuedBeforeClose: ReadonlySet<string>, journal: JournalStorePort): void {
    this.queuedBeforeImportClose = queuedBeforeClose;
    this.replay = recoverReplaySettleOrder(journal, this.host.runId);
  }

  /** run 结算：放行全部停驻的 replay 结算（ReplaySettleOrder 的 open 语义）。 */
  openReplayOrder(): void {
    this.replay.open();
  }

  private pumpActor(actor: Actor): void {
    if (this.host.isRunSettled()) return;
    if (actor.current !== undefined) return;
    if (actor.liveQueue.length === 0) return;
    if (this.activeAsks >= this.host.caps.maxConcurrency) return;
    const node = actor.liveQueue.shift()!;
    actor.current = node;
    this.activeAsks++;
    void this.dispatch(node);
  }

  private async dispatch(node: AskNode): Promise<void> {
    let session: SessionRef;
    try {
      session = await this.ensureSession(node.actor);
    } catch (cause) {
      if (this.host.isRunSettled() || node.settled) return;
      // 把 cause 的文本带进 message：WorkflowError.toJSON 只落 code/message，cause 不进 journal 也
      // 无人记日志，于是「创建 actor 会话失败」在 GUI / journal 里成了无法诊断的黑盒
      // （实机上底层其实是 session_task_link 的 FOREIGN KEY constraint failed）。
      this.settleFailed(
        node,
        new WorkflowError(
          "DriverError",
          `Failed to create the subagent session: ${describeCause(cause)}`,
          { cause },
        ),
      );
      return;
    }
    if (this.host.isRunSettled() || node.settled) return;
    // node-dispatched 在会话就绪之后。进程级并发闸门
    // 不在这里：它按**模型请求**准入，住在 driver 之下的 runtime deps 里；调度器只守
    // per-run 的 ask 级上界。
    this.host.record({ type: "node-dispatched", instance: node.instance });
    node.dispatched = true;
    const message: AskMessage = {
      instructions: node.instructions,
      typed: node.spec.typed,
      schema: node.spec.schema,
    };
    this.host.driver.startAsk(session, node.instance, message);
  }

  private ensureSession(actor: Actor): Promise<SessionRef> {
    if (actor.sessionPromise !== undefined) return actor.sessionPromise;
    // 种子只有到分歧点才知道（运行期发现），所以必须在这里、由引擎侧交给 driver——引擎持有
    // 导入态，driver 持有会话 store，这个签名是两者的最小汇合点。
    const seed = actor.imported?.seed();
    const promise = this.host.driver.createActorSession(actor.ref, actor.persona, seed).then((session) => {
      actor.session = session;
      // resolvedModel 由宿主侧的 runtime 工厂在 createActorSession **内部**写下（它才知道
      // "lite" 落到哪个模型）。putActor 是整条记录的替换，所以这条写入必须把刚写下的值读回来
      // 带过去，否则这里就会把它抹掉——档位解析的审计与 resume 依据随之丢失。
      const resolvedModel = this.journal.getActor(
        this.host.runId,
        actor.ref.siteId,
        actor.ref.ordinal,
      )?.resolvedModel;
      this.journal.putActor({
        runId: this.host.runId,
        siteId: actor.ref.siteId,
        ordinal: actor.ref.ordinal,
        name: actor.name,
        persona: actor.persona,
        sessionId: session.id,
        resolvedModel,
      });
      return session;
    });
    actor.sessionPromise = promise;
    return promise;
  }

  // ——————————————————————————————— 内部：结算 ———————————————————————————————

  private settleOk(node: AskNode, artifact: unknown): void {
    if (node.settled) return;
    node.settled = true;
    this.journal.putNode(this.nodeRecordFor(node, { status: "completed", result: artifact }));
    this.host.record({ type: "node-settled", instance: node.instance, outcome: "ok" });
    this.finishLiveNode(node);
    node.deferred.resolve(artifact);
  }

  private settleFailed(node: AskNode, error: WorkflowError): void {
    if (node.settled) return;
    node.settled = true;
    // 结算失败必须落 journal（覆盖准入时的 running）：失败是"完结"，且脚本可能已观察到该 rejection
    // 并据此分支，replay 必须复现它——journal 化失败是重放正确性的硬性要求，而非可选。
    this.journal.putNode(this.nodeRecordFor(node, { status: "failed", error: error.toJSON() }));
    this.host.record({ type: "node-settled", instance: node.instance, outcome: "failed", error: error.toJSON() });
    this.finishLiveNode(node);
    // 节点失败只 reject 该 ask，不失败整个 run（脚本可 try/catch）。
    node.deferred.reject(error);
  }

  private finishLiveNode(node: AskNode): void {
    this.liveNodes.delete(refToString(node.instance));
    if (node.actor.current === node) {
      node.actor.current = undefined;
      this.activeAsks--;
    }
    this.pumpAll();
  }

  private nodeRecordFor(
    node: AskNode,
    outcome: { status: "completed"; result: unknown } | { status: "failed"; error: NodeRecord["error"] },
  ): NodeRecord {
    const record: NodeRecord = {
      runId: this.host.runId,
      siteId: node.instance.siteId,
      ordinal: node.instance.ordinal,
      kind: "ask",
      actorSiteId: node.actor.ref.siteId,
      actorOrdinal: node.actor.ref.ordinal,
      actorSeq: node.actorSeq,
      inputHash: node.hash,
      status: outcome.status,
    };
    if (outcome.status === "completed") record.result = outcome.result;
    else record.error = outcome.error;
    if (node.lastStats !== undefined) record.stats = this.journaledStats(node);
    return record;
  }

  /**
   * 携带 ask 的 stats 剥掉 `worldToolCalls`（批次 2-2）：缺键 ⇒ 更后续修订的 takeIfPure 按
   * 「碰过世界」拒收（保守），携带结果因此永远不会被免费导入——它的上下文属于被放弃的
   * 尝试，哈希链看不见那段历史。
   */
  private journaledStats(node: AskNode): AskStats {
    if (!this.priorTranscriptAsks.has(refToString(node.instance))) return node.lastStats!;
    const { worldToolCalls: _dropped, ...rest } = node.lastStats!;
    void _dropped;
    return rest as AskStats;
  }
}

/** cause → 一行有界文本（Error 取 message，其余 String()；空则给占位）。 */
function describeCause(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  const trimmed = text.trim();
  if (trimmed.length === 0) return "unknown error";
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/**
 * 作者指令的开头（{@link INSTRUCTIONS_HEAD_MAX_CHARS} 个字符，去两端空白，**不加省略号**）。
 * 空指令返回 undefined：缺席的键比一个空串诚实——读面据此退回「不知道它被交代了什么」。
 */
function headOfInstructions(instructions: string): string | undefined {
  const trimmed = instructions.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= INSTRUCTIONS_HEAD_MAX_CHARS
    ? trimmed
    : trimmed.slice(0, INSTRUCTIONS_HEAD_MAX_CHARS);
}
