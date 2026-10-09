// FreeCodeZ W-14：新薄 SDK + 桥接（附录 G.1 编排实施；FC 自有 API 面，不与任何第三方
// SDK 逐字同构——G.0-2）。会话命名空间（G.0-4）：sessionId 贯穿 observe/action 的
// session 参数，多会话快照缓存隔离。G.3 划分：快照缓存/scale/verification/剪贴板/
// blockedApps 在引擎；闩锁/租约/拆分教学/跨应用预检在本层。
import { ComputerControlGate } from "../host/control-latch";
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

  constructor(options: ComputerUseSdkOptions) {
    this.transport = options.transport;
    this.sessionId = options.sessionId;
    this.gate = options.gate ?? new ComputerControlGate();
    this.platform = options.platform ?? process.platform;
    this.readUserActivity = createUserActivityReader(options.readUserActivity);
    this.activityGate = options.activityGate ?? {};
  }

  // ---- 探测面 ----

  async capabilities(): Promise<unknown> {
    return this.call("capabilities", {});
  }

  async listApps(): Promise<unknown> {
    return this.call("listApps", {});
  }

  async listWindows(target: { app: string }): Promise<unknown> {
    return this.call("listWindows", { app: target.app, session: this.sessionId });
  }

  async getAppState(
    target: AppTarget & { includeScreenshot?: boolean },
  ): Promise<unknown> {
    return this.call("getAppState", {
      ...this.targetParams(target),
      noScreenshot: target.includeScreenshot === false ? true : undefined,
    });
  }

  // ---- 动作面 ----

  async leftClick(input: {
    target: AppTarget;
    element?: ActionTarget;
    button?: "left" | "right" | "middle";
    count?: number;
    modifiers?: string;
  }): Promise<unknown> {
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
