// FreeCodeZ W-14：新薄 SDK + 桥接（附录 G.1 编排实施；FC 自有 API 面，不与任何第三方
// SDK 逐字同构——G.0-2）。会话命名空间（G.0-4）：sessionId 贯穿 observe/action 的
// session 参数，多会话快照缓存隔离。G.3 划分：快照缓存/scale/verification/剪贴板/
// blockedApps 在引擎；闩锁/租约/拆分教学/跨应用预检在本层。
import { ComputerControlGate } from "../host/control-latch";
import {
  cursorEventsForClick,
  cursorEventsForDrag,
  cursorEventsForKey,
  cursorEventsForText,
  emitCursorEvents,
} from "../host/cursor-events.js";
import {
  buildCuaAppSnapshot,
  resolveCuaAppIdentity,
  type CuaAppIdentity,
  type ListAppsEntry,
} from "./cua-app-projection";
import { loadAppInstructions, setAppInstructionsRoot } from "./app-instructions";
import {
  createUserActivityReader,
  waitForUserQuiet,
  type UserActivityGateOptions,
  type UserActivityReader,
} from "../host/user-activity-gate";
import {
  ComputerUseSdkError,
  mapEngineError,
  type SdkErrorMapping,
} from "./errors";

export interface ComputerEngineTransport {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export type AppTarget =
  | { app: string; windowId?: number; windowIndex?: number }
  | { app: string; windowId?: number; windowIndex?: number; restoreWindow: true };

export type ActionTarget =
  | { kind: "element"; index: number }
  | { kind: "coordinate"; x: number; y: number; scale?: number };

export interface ComputerUseSdkOptions {
  transport: ComputerEngineTransport;
  /** G.0-4：SDK 自身会话身份，注入全部 observe/action 的 session 参数。 */
  sessionId: string;
  gate?: ComputerControlGate;
  /** 测试/装机注入；缺省 process.platform。 */
  platform?: NodeJS.Platform;
  /** W-26 用户活动闸检测器；缺席=恒放行（干预面缺席不折断动作本体）。 */
  readUserActivity?: UserActivityReader;
  activityGate?: Partial<UserActivityGateOptions>;
  /** W-28 HUD 帧出口：动作前发 point/down/up 帧、text 发 loading 帧（旁路可视化）。 */
  onInputEvent?: (event: unknown) => void;
  /** G3（2026-10-11 装机审计）：app-instructions 资产根。SDK 被打进 node_repl server
   * bundle 后源码相对深度失效，由桥面从解析到的 sidecar 产物目录推导传入
   *（build-sidecar 会把 docs/app-instructions 拷进 dist 随产物走）。 */
  docsRoot?: string;
}

/** typeText 单次上限（UTF-16 code units，G.1 拆分教学）。 */
const TYPE_CHUNK_LIMIT = 1024;

export class ComputerUseSdk {
  private readonly transport: ComputerEngineTransport;
  private readonly sessionId: string;
  readonly gate: ComputerControlGate;
  private readonly platform: NodeJS.Platform;
  private readonly readUserActivity: UserActivityReader;
  private readonly activityGate: Partial<UserActivityGateOptions>;
  private readonly onInputEvent: ((event: unknown) => void) | undefined;

  constructor(options: ComputerUseSdkOptions) {
    this.transport = options.transport;
    this.sessionId = options.sessionId;
    this.gate = options.gate ?? new ComputerControlGate();
    this.platform = options.platform ?? process.platform;
    this.readUserActivity = createUserActivityReader(options.readUserActivity);
    this.activityGate = options.activityGate ?? {};
    this.onInputEvent = options.onInputEvent;
    if (options.docsRoot) setAppInstructionsRoot(options.docsRoot);
  }

  // ---- 探测面 ----

  async capabilities(): Promise<unknown> {
    return this.call("capabilities", {});
  }

  private lastCuaAppSnapshot: Map<number, CuaAppIdentity> | undefined;

  async listApps(): Promise<unknown> {
    const result = await this.call("listApps", {});
    // W-30：缓存最近 listApps 快照供 cuaApp 投影（G.1）。
    const entries = extractAppEntries(result);
    if (entries) {
      this.lastCuaAppSnapshot = buildCuaAppSnapshot(entries);
    }
    return result;
  }

  /** cuaApp 身份投影：按动作输入（app_ref）解析最近快照。 */
  cuaAppFor(input: unknown): CuaAppIdentity | undefined {
    return this.lastCuaAppSnapshot
      ? resolveCuaAppIdentity(input, this.lastCuaAppSnapshot)
      : undefined;
  }

  async listWindows(target: { app: string }): Promise<unknown> {
    return this.call("listWindows", { app: target.app, session: this.sessionId });
  }

  async getAppState(
    target: AppTarget & { includeScreenshot?: boolean },
  ): Promise<unknown> {
    const result = await this.call("getAppState", {
      ...this.targetParams(target),
      noScreenshot: target.includeScreenshot === false ? true : undefined,
    });
    // W-27：命中应用要点随结果注入（G.1 app-instructions 注入点）。
    const instructions = loadAppInstructions({ name: target.app });
    return instructions !== undefined && result && typeof result === "object"
      ? { ...(result as Record<string, unknown>), appInstructions: instructions }
      : result;
  }

  // ---- 动作面 ----

  async leftClick(input: {
    target: AppTarget;
    element?: ActionTarget;
    button?: "left" | "right" | "middle";
    count?: number;
    modifiers?: string;
  }): Promise<unknown> {
    // W-28：坐标点击发 point/down/up 帧；元素点击坐标不可知（引擎侧缓存持有），
    // 不发帧——旁路可视化不折断动作本体。
    if (input.element?.kind === "coordinate") {
      const scale = input.element.scale ?? 1;
      emitCursorEvents(
        this.onInputEvent,
        cursorEventsForClick({
          x: input.element.x / scale,
          y: input.element.y / scale,
          button: input.button ?? "left",
        }),
      );
    }
    return this.call("click", {
      ...this.targetParams(input.target),
      ...this.actionTargetParams(input.element),
      clickCount: input.count,
      mouseButton: input.button,
      modifiers: input.modifiers,
    });
  }

  async scroll(input: {
    target: AppTarget;
    element?: ActionTarget;
    direction: "up" | "down" | "left" | "right";
    /** 旧 amount 语义（0-100）→ pages = amount/100（G.1）。 */
    amount: number;
  }): Promise<unknown> {
    return this.call("scroll", {
      ...this.targetParams(input.target),
      ...this.actionTargetParams(input.element),
      direction: input.direction,
      pages: input.amount / 100,
    });
  }

  async drag(input: {
    target: AppTarget;
    from: ActionTarget;
    to: ActionTarget & { app?: string };
  }): Promise<unknown> {
    // 跨应用预检（G.1）：两端目标 app 不同 → INVALID_REQUEST，不下发引擎。
    if (input.to.app !== undefined && input.to.app !== input.target.app) {
      throw new ComputerUseSdkError(
        { sdkCode: "INVALID_REQUEST", retry: "never", possiblySent: false },
        "drag targets must belong to the same app",
      );
    }
    const from = this.actionTargetParams(input.from);
    const to = this.actionTargetParams(input.to);
    emitCursorEvents(
      this.onInputEvent,
      cursorEventsForDrag({ fromX: from.x, fromY: from.y, toX: to.x, toY: to.y }),
    );
    return this.call("drag", {
      ...this.targetParams(input.target),
      fromElementIndex: from.elementIndex,
      toElementIndex: to.elementIndex,
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
    });
  }

  async type(input: {
    target: AppTarget;
    text: string;
    /** 有目标先聚焦（G.1：click 聚焦后 typeText）。 */
    element?: ActionTarget;
  }): Promise<unknown> {
    if (input.element) {
      await this.leftClick({ target: input.target, element: input.element });
    }
    emitCursorEvents(this.onInputEvent, cursorEventsForText({ text: input.text }));
    const results: unknown[] = [];
    // >1024 UTF-16 拆分（G.1）：引擎单发有界，SDK 负责分段教学与顺序保真。
    for (let offset = 0; offset < input.text.length; offset += TYPE_CHUNK_LIMIT) {
      results.push(
        await this.call("typeText", {
          ...this.targetParams(input.target),
          text: input.text.slice(offset, offset + TYPE_CHUNK_LIMIT),
        }),
      );
    }
    return results.length === 1 ? results[0] : results;
  }

  async setValue(input: {
    target: AppTarget;
    element: Extract<ActionTarget, { kind: "element" }>;
    value: string;
  }): Promise<unknown> {
    return this.call("setValue", {
      ...this.targetParams(input.target),
      elementIndex: input.element.index,
      value: input.value,
    });
  }

  async selectText(input: {
    target: AppTarget;
    element: Extract<ActionTarget, { kind: "element" }>;
    textRange?: { start: number; end: number };
  }): Promise<unknown> {
    // D4：全量范围=click 聚焦 + CmdOrCtrl+A；部分范围依赖上游 AXSelectedTextRange
    // 语义化（PR 未合入前 not_selectable，教学改用全选+重写）。
    if (input.textRange !== undefined) {
      throw new ComputerUseSdkError(
        { sdkCode: "not_selectable", retry: "never", possiblySent: false },
        "partial text range selection is not available; select all (no textRange) and rewrite",
      );
    }
    await this.leftClick({ target: input.target, element: input.element });
    return this.call("hotkey", {
      ...this.targetParams(input.target),
      key: "CmdOrCtrl+A",
    });
  }

  async key(input: {
    target: AppTarget;
    key: string;
    repeat?: number;
  }): Promise<unknown> {
    // hold_seconds 无引擎对应（D8 砍）；repeat 由 SDK 循环（G.1）。
    const times = Math.max(1, input.repeat ?? 1);
    emitCursorEvents(this.onInputEvent, cursorEventsForKey({ key: input.key }));
    const results: unknown[] = [];
    for (let i = 0; i < times; i += 1) {
      results.push(
        await this.call("pressKey", {
          ...this.targetParams(input.target),
          key: input.key,
        }),
      );
    }
    return results.length === 1 ? results[0] : results;
  }

  // ---- W-31 方法缺口组合实现（D8：组合优先，语义化待上游 PR）----

  /** element_focus：聚焦元素不点击（D8 组合实现——引擎无原生 focus；click 的 AX
   * 聚焦路径是当前最近似，语义化 AXRequestedFocusConfirmation 待 orca 上游 PR）。 */
  async elementFocus(input: {
    target: AppTarget;
    element: Extract<ActionTarget, { kind: "element" }>;
  }): Promise<unknown> {
    return this.leftClick({ target: input.target, element: input.element });
  }

  /** read_element：桥层快照内查找（G.0-3：模型面只有 index+treeText）——重观测取
   * 新快照，按 index 从 treeText 行提取该元素行 + focusedElementId。 */
  async readElement(input: {
    target: AppTarget;
    elementIndex: number;
  }): Promise<{ elementIndex: number; line: string | null; focusedElementId: number | null; snapshotId: string }> {
    const result = (await this.getAppState({
      app: input.target.app,
      windowId: input.target.windowId,
      windowIndex: input.target.windowIndex,
      includeScreenshot: false,
    })) as {
      snapshot?: { id?: string; treeText?: string; focusedElementId?: number | null };
    };
    const snapshot = result?.snapshot ?? {};
    const treeText = typeof snapshot.treeText === "string" ? snapshot.treeText : "";
    // tree 行按引擎渲染约定携带 [N] 索引标记；命中失败返回 null（模型重观测自查）。
    const line =
      treeText
        .split("\n")
        .find((candidate) => candidate.includes(`[${input.elementIndex}]`)) ?? null;
    return {
      elementIndex: input.elementIndex,
      line,
      focusedElementId: snapshot.focusedElementId ?? null,
      snapshotId: String(snapshot.id ?? ""),
    };
  }

  /** element_at_point：坐标命中元素（桥层近似——模型面无元素 frame 缓存，G.0-1）。
   * D8 裁定=上游 PR 候选（AXHitTest 语义化）；当前组合实现返回新快照的
   * focusedElementId 供模型比对，坐标直接命中留待上游。 */
  async elementAtPoint(input: {
    target: AppTarget;
    x: number;
    y: number;
    scale?: number;
  }): Promise<{ clicked: unknown; focusedElementId: number | null }> {
    await this.leftClick({
      target: input.target,
      element: { kind: "coordinate", x: input.x, y: input.y, scale: input.scale },
    });
    const state = (await this.getAppState({
      app: input.target.app,
      windowId: input.target.windowId,
      windowIndex: input.target.windowIndex,
      includeScreenshot: false,
    })) as { snapshot?: { focusedElementId?: number | null } };
    return { clicked: true, focusedElementId: state?.snapshot?.focusedElementId ?? null };
  }

  async performAction(input: {
    target: AppTarget;
    element: Extract<ActionTarget, { kind: "element" }>;
    action: string;
  }): Promise<unknown> {
    return this.call("performSecondaryAction", {
      ...this.targetParams(input.target),
      elementIndex: input.element.index,
      action: input.action,
    });
  }

  async paste(input: { target: AppTarget; text: string }): Promise<unknown> {
    // 仅 text 档（D8：md/html 砍）。
    emitCursorEvents(this.onInputEvent, cursorEventsForText({ text: input.text }));
    return this.call("pasteText", {
      ...this.targetParams(input.target),
      text: input.text,
    });
  }

  async requestAccess(input: { capabilities?: Array<"accessibility" | "screenshots"> }): Promise<{
    platform: string;
    granted: boolean;
    permissions: Array<{ id: string; status: string }>;
    note?: string;
  }> {
    // 非 darwin：合成"无需系统授权"应答（G.1）；darwin 经宿主权限面探测（W-13）。
    if (this.platform !== "darwin") {
      return {
        platform: this.platform,
        granted: true,
        permissions: (input.capabilities ?? ["accessibility", "screenshots"]).map((id) => ({
          id,
          status: "not-required",
        })),
        note: "no system permission gate on this platform",
      };
    }
    const { getComputerUsePermissionStatus } = await import(
      "../main/computer/macos-computer-use-permissions"
    );
    const status = await getComputerUsePermissionStatus();
    return {
      platform: status.platform,
      granted: status.permissions.every((p) => p.status === "granted"),
      permissions: status.permissions.map((p) => ({ id: p.id, status: p.status })),
    };
  }

  /** stop_computer_control（G.1）：闩锁幂等；豁免面 request_access/stop。 */
  stop(reason: string): { stopped: true; reason: string } {
    return this.gate.stop(reason);
  }

  // ---- 内部 ----

  private targetParams(target: AppTarget): Record<string, unknown> {
    return {
      app: target.app,
      session: this.sessionId,
      windowId: target.windowId,
      windowIndex: target.windowIndex,
      restoreWindow: "restoreWindow" in target ? target.restoreWindow : undefined,
    };
  }

  private actionTargetParams(
    target: ActionTarget | undefined,
  ): Record<string, number | undefined> {
    if (!target) return {};
    if (target.kind === "element") return { elementIndex: target.index };
    // 坐标换算（G.1）：像素→窗口坐标 action_x = px/scale（scale 缺省 1）。
    const scale = target.scale ?? 1;
    return { x: target.x / scale, y: target.y / scale };
  }

  /** W-26：观测面不套闸（读不驱动输入），动作面执行前等待用户静默。 */
  private static readonly OBSERVE_METHODS = new Set([
    "capabilities",
    "listApps",
    "listWindows",
    "getAppState",
  ]);

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.gate.assertMethodAllowed(method);
    if (!ComputerUseSdk.OBSERVE_METHODS.has(method)) {
      const quiet = await waitForUserQuiet(this.readUserActivity, this.activityGate);
      if (!quiet.ok) {
        throw new ComputerUseSdkError(
          { sdkCode: "user_active", retry: "retry", possiblySent: false },
          quiet.error.message,
        );
      }
    }
    let payload: unknown;
    try {
      payload = await this.transport.request(method, params);
    } catch (error) {
      // 传输级失败（sidecar 死/不可达）= 引擎不可用（R7 fail-closed：显式拒，不空转）。
      throw new ComputerUseSdkError(
        { sdkCode: "CUA_NOT_READY", retry: "retry", possiblySent: false },
        `computer engine unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const response = payload as { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } };
    if (response && response.ok === true) {
      return response.result;
    }
    const code = response?.error?.code;
    const message = response?.error?.message ?? `engine error in ${method}`;
    const mapping: SdkErrorMapping = mapEngineError(code ?? "invalid_argument", message);
    throw new ComputerUseSdkError(mapping, message, code);
  }
}

/** listApps 结果条目提取（apps 数组或裸数组两种 wire 形状）。 */
function extractAppEntries(result: unknown): ListAppsEntry[] | undefined {
  if (Array.isArray(result)) return result as ListAppsEntry[];
  const record = result as { apps?: unknown } | null;
  if (Array.isArray(record?.apps)) return record.apps as ListAppsEntry[];
  return undefined;
}
