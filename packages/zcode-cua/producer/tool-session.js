/* eslint-disable max-lines -- 会话状态(观察基线/索引位移台账/帧注册表/投影/元素解析)是同一份索引位移 fail-closed 语义的连续体,拆分会让保护规则失去单一判定点。 */
// B2 内部模块:runtime 会话状态(跨 cell 的"真身")——观察基线、模型可见索引台账、
// 帧注册表(像素→指针投影 frame_pixel_projection_v1)。语义对齐官方 producer 的
// session/frames/resolveTarget 簇(node-repl-host 112401-112639);指纹匹配为行为等价简化,
// 差异说明见 docs/spec/computer-control-capability.md §10。
import { randomUUID } from "node:crypto";

export class TargetResolveError extends Error {
  constructor(reason, message, stateId) {
    super(message);
    this.name = "TargetResolveError";
    this.reason = reason;
    if (stateId !== undefined) this.stateId = stateId;
  }
}

export function axElementIdentity(element) {
  return `${element?.role ?? element?.kind ?? ""}\0${element?.title ?? ""}`;
}

function describeIdentity(identity) {
  const [role, title] = identity.split("\0");
  return title ? `${role} "${title}"` : (role ?? "(unknown)");
}

function elementCenter(bounds) {
  const [x, y, w, h] = bounds;
  return { x: x + Math.floor(w / 2), y: y + Math.floor(h / 2) };
}

function visibleElementCenter(elementBounds, windowBounds) {
  const [ex, ey, ew, eh] = elementBounds;
  const [wx, wy, ww, wh] = windowBounds;
  if (ew <= 0 || eh <= 0) return undefined;
  if (ww <= 0 || wh <= 0) return elementCenter(elementBounds);
  const left = Math.max(ex, wx);
  const top = Math.max(ey, wy);
  const right = Math.min(ex + ew, wx + ww);
  const bottom = Math.min(ey + eh, wy + wh);
  if (right <= left || bottom <= top) return undefined;
  return elementCenter([left, top, right - left, bottom - top]);
}

const FRAME_TTL_MS = 15_000;

/**
 * 帧注册表:观察产帧时钉住几何(pointer/display 拓扑指纹),动作时按
 * `frame_pixel_projection_v1` 把 raster 像素投影成全局指针点(公式逐字对齐官方
 * projectFramePixelToPointer),helper 端会独立复算并校验(frame_provenance)。
 */
export class FrameRegistry {
  #frames = new Map();

  issue(frame) {
    const frame_id = `frame-${randomUUID()}`;
    const record = {
      frame_id,
      issued_at_ms: Date.now(),
      expires_at_ms: Date.now() + FRAME_TTL_MS,
      delivered: frame.delivered,
      source: frame.source,
      pointer: frame.pointer,
      app: frame.app,
      window: frame.window,
      display: frame.display,
      capture_surfaces: frame.capture_surfaces ?? null,
      actionable: frame.actionable !== false,
      non_actionable_reason: frame.non_actionable_reason ?? null,
    };
    this.#frames.set(frame_id, record);
    // 全局 32 份上限,与 helper token 注册表同档;旧帧自然过期。
    while (this.#frames.size > 32) {
      const oldest = this.#frames.keys().next().value;
      this.#frames.delete(oldest);
    }
    return record;
  }

  get(frameId) {
    return this.#frames.get(frameId);
  }

  resolveForAction(frameId) {
    const frame = this.#frames.get(frameId);
    if (!frame) {
      throw new TargetResolveError(
        "frame_reference_invalid",
        `frame_id "${frameId}" is not an actionable frame in this transport; capture a fresh screenshot and copy its pixels.`,
      );
    }
    return this.assertActionable(frame);
  }

  resolveLatestForAction() {
    let latest;
    for (const frame of this.#frames.values()) {
      if (!latest || frame.issued_at_ms > latest.issued_at_ms) latest = frame;
    }
    if (!latest) {
      throw new TargetResolveError(
        "frame_reference_invalid",
        "no actionable frame is available in this transport; call get_app_state with include_screenshot or getScreenshot first.",
      );
    }
    return this.assertActionable(latest);
  }

  assertActionable(frame) {
    if (!frame.actionable) {
      throw new TargetResolveError(
        "frame_reference_invalid",
        `frame "${frame.frame_id}" is not actionable (${frame.non_actionable_reason ?? "unknown"}); capture a fresh screenshot.`,
      );
    }
    if (frame.expires_at_ms < Date.now()) {
      throw new TargetResolveError(
        "frame_reference_invalid",
        `frame "${frame.frame_id}" has expired; capture a fresh screenshot and copy its pixels.`,
      );
    }
    return frame;
  }

  clear() {
    this.#frames.clear();
  }
}

/** 像素→指针点投影(官方公式,像素中心采样)。 */
export function projectFramePixelToPointer(frame, pixel) {
  const { x, y } = pixel;
  const { width: deliveredWidth, height: deliveredHeight } = frame.delivered;
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= deliveredWidth ||
    y >= deliveredHeight
  ) {
    throw new TargetResolveError(
      "frame_reference_invalid",
      `frame pixel coordinate (${String(x)}, ${String(y)}) is outside ${deliveredWidth}x${deliveredHeight}`,
    );
  }
  const { crop } = frame.source;
  const cropWidth = crop.right - crop.left;
  const cropHeight = crop.bottom - crop.top;
  if (
    deliveredWidth <= 0 ||
    deliveredHeight <= 0 ||
    frame.source.width <= 0 ||
    frame.source.height <= 0 ||
    cropWidth <= 0 ||
    cropHeight <= 0 ||
    frame.pointer.width <= 0 ||
    frame.pointer.height <= 0
  ) {
    throw new TargetResolveError(
      "frame_reference_invalid",
      "frame coordinate transform contains a zero or negative extent",
    );
  }
  const sourceX = crop.left + ((x + 0.5) / deliveredWidth) * cropWidth;
  const sourceY = crop.top + ((y + 0.5) / deliveredHeight) * cropHeight;
  return {
    x: frame.pointer.x + sourceX * (frame.pointer.width / frame.source.width),
    y: frame.pointer.y + sourceY * (frame.pointer.height / frame.source.height),
  };
}

/**
 * runtime 会话:每个 sessionId 一份。观察记忆(索引→native token 的解析基线)+
 * 模型可见台账(索引位移校验:模型看过的树 vs 最新树自比会失效,必须分账)+
 * 帧注册表。
 */
export class CuaToolSession {
  #states = [];
  #modelVisible = new Map();
  frames = new FrameRegistry();
  #stateCounter = 0;

  get stateCount() {
    return this.#states.length;
  }

  nextStateId() {
    this.#stateCounter += 1;
    return `s-${this.#stateCounter}`;
  }

  /**
   * 记住一次观察。tree_shown_to_model!==false 时按 **app** 记录"模型在该索引看到的元素身份"
   * (跨观察覆盖),这是索引位移校验的唯一依据——隐藏观察(getApp 绑定/截图/elements())绝不能
   * 记账,也绝不能被当作比对基准:否则拿当前树跟当前树自比必然一致,静默点错元素的保护失效
   * (官方 2026-09-15 探针 bug 同款)。
   */
  remember(state, options = {}) {
    this.#states.push(state);
    while (this.#states.length > 8) this.#states.shift();
    if (options.treeShownToModel !== false) {
      const ledger = state.elements.map((element) => ({
        identity: axElementIdentity(element),
        displayTitle: element.title ?? "",
        native: typeof element.native === "string" ? element.native : "",
      }));
      this.#modelVisible.set(modelVisibleKey(state), ledger);
    }
  }

  latestState() {
    return this.#states[this.#states.length - 1];
  }

  latestStateForAppRef(appRef, options = {}) {
    if (!appRef || typeof appRef !== "object") return undefined;
    for (let i = this.#states.length - 1; i >= 0; i -= 1) {
      const state = this.#states[i];
      if (stateMatchesAppRef(state, appRef, options.ignoreWindow === true)) return state;
    }
    return undefined;
  }

  #ledgerFor(state) {
    return this.#modelVisible.get(modelVisibleKey(state));
  }

  modelVisibleIdentityAt(state, index) {
    return this.#ledgerFor(state)?.[index]?.identity;
  }

  modelVisibleDisplayTitleAt(state, index) {
    return this.#ledgerFor(state)?.[index]?.displayTitle;
  }

  modelVisibleFingerprintAt(state, index) {
    const entry = this.#ledgerFor(state)?.[index];
    return entry && entry.native ? { native: entry.native, identity: entry.identity } : undefined;
  }

  modelVisibleIdentityCount(state, identity) {
    const ledger = this.#ledgerFor(state) ?? [];
    return ledger.filter((entry) => entry.identity === identity).length;
  }

  clear() {
    this.#states = [];
    this.#modelVisible.clear();
    this.frames.clear();
  }
}

function modelVisibleKey(state) {
  const app = state?.app ?? {};
  return String(app.pid ?? app.bundle_id ?? app.name ?? "*");
}

function stateMatchesAppRef(state, appRef, ignoreWindow) {
  const app = state.app ?? {};
  const win = state.window ?? {};
  if (typeof appRef.pid === "number" && app.pid !== appRef.pid) return false;
  if (typeof appRef.bundle_id === "string" && appRef.bundle_id) {
    const wanted = appRef.bundle_id.toLowerCase();
    const have = typeof app.bundle_id === "string" ? app.bundle_id.toLowerCase() : "";
    if (have !== wanted) return false;
  }
  if (typeof appRef.name === "string" && appRef.name) {
    if (app.name !== appRef.name) return false;
  }
  if (!ignoreWindow && typeof appRef.window_id === "number") {
    if (win.window_id !== appRef.window_id) return false;
  }
  return Boolean(
    typeof appRef.pid === "number" ||
      (typeof appRef.bundle_id === "string" && appRef.bundle_id) ||
      (typeof appRef.name === "string" && appRef.name),
  );
}

export function appRefFromState(state) {
  const app = state.app ?? {};
  const ref = {};
  if (app.bundle_id) ref.bundle_id = app.bundle_id;
  if (typeof app.pid === "number") ref.pid = app.pid;
  if (typeof state.window?.window_id === "number") ref.window_id = state.window.window_id;
  if (app.name) ref.name = app.name;
  return ref;
}

function hasAppIdentity(appRef) {
  if (!appRef || typeof appRef !== "object" || Array.isArray(appRef)) return false;
  return (
    typeof appRef.pid === "number" ||
    typeof appRef.bundle_id === "string" ||
    typeof appRef.name === "string"
  );
}

function observationForIndex(session, appRef) {
  return (
    session.latestStateForAppRef(appRef) ??
    session.latestStateForAppRef(appRef, { ignoreWindow: true }) ??
    (hasAppIdentity(appRef) ? null : session.latestState())
  );
}

/**
 * 元素索引→native token 解析,含索引位移校验(A5 fail-closed)与可选重定位:
 * 模型看过的索引已被别的元素顶掉时,allowRelocation 允许按 native/身份重新找回并附
 * relocation 收据;否则一律拒(element_unavailable 语义类,强制先观察)。
 */
export function resolveElementTarget(session, target, context = {}) {
  const state = observationForIndex(session, context.appRef);
  if (!state) {
    throw new TargetResolveError(
      "state_expired",
      `no observed accessibility state for this app, so element index ${target.index} cannot be resolved. Call get_app_state for the app first, then act in the same call.`,
    );
  }
  const element = state.elements[target.index];
  if (!element) {
    throw new TargetResolveError(
      "index_out_of_range",
      `element index ${target.index} is out of range for the latest observation of this app (it has ${state.elements.length} elements). Call get_app_state again and re-pick the index.`,
    );
  }
  const seenIdentity = session.modelVisibleIdentityAt(state, target.index);
  const liveIdentity = axElementIdentity(element);
  if (seenIdentity !== undefined && seenIdentity !== liveIdentity) {
    return resolveShiftedIndex(session, state, target.index, seenIdentity, element, context);
  }
  return buildFromElement(element, state);
}

function resolveShiftedIndex(session, state, index, seenIdentity, live, context) {
  const [seenRole] = seenIdentity.split("\0");
  const seenDisplayTitle = session.modelVisibleDisplayTitleAt(state, index);
  const seenDescribed =
    seenDisplayTitle !== undefined && seenDisplayTitle !== ""
      ? `${seenRole} "${seenDisplayTitle}"`
      : describeIdentity(seenIdentity);
  const shifted = `element index ${index} no longer refers to the element you saw there: the tree has shifted from ${seenDescribed} to ${live.title ? `${live.role ?? live.kind ?? ""} "${live.title}"` : (live.role ?? live.kind ?? "(unknown)")} at that position.`;
  const stored = session.modelVisibleFingerprintAt(state, index);
  if (context.allowRelocation !== true || stored === undefined) {
    throw new TargetResolveError(
      "element_index_shifted",
      `${shifted} Acting on it would hit a different element. Call get_app_state again and re-pick the index.`,
    );
  }
  if (session.modelVisibleIdentityCount(state, seenIdentity) > 1) {
    throw new TargetResolveError(
      "element_anchor_ambiguous",
      `${shifted} The element you saw there was not uniquely identifiable even in that observation (several elements shared ${seenDescribed}), so it cannot be located again. Call get_app_state and pick a target that is distinguishable by role and title.`,
    );
  }
  const match = findFingerprintMatch(stored, state.elements);
  if (match === null) {
    const candidates = state.elements.filter(
      (candidate) => axElementIdentity(candidate) === seenIdentity,
    ).length;
    throw new TargetResolveError(
      "element_index_shifted",
      `${shifted} It could not be located anywhere in the current tree (${candidates === 0 ? "it is gone" : `${candidates} elements now match it ambiguously`}). Call get_app_state again and re-pick the index.`,
    );
  }
  const actualIndex = state.elements.findIndex((candidate) => candidate.native === match.native);
  const relocated = actualIndex >= 0 ? state.elements[actualIndex] : undefined;
  if (relocated === undefined) {
    throw new TargetResolveError(
      "element_index_shifted",
      `${shifted} Call get_app_state again and re-pick the index.`,
    );
  }
  return {
    ...buildFromElement(relocated, state),
    relocation: {
      requested_index: index,
      actual_index: actualIndex,
      match_criteria: match.match_criteria,
      confidence: match.confidence,
      seen: seenDescribed,
    },
  };
}

function findFingerprintMatch(stored, elements) {
  const byNative = elements.find((candidate) => candidate.native && candidate.native === stored.native);
  if (byNative) {
    return { native: byNative.native, match_criteria: "native", confidence: "exact" };
  }
  const byIdentity = elements.filter(
    (candidate) => axElementIdentity(candidate) === stored.identity && candidate.native,
  );
  if (byIdentity.length === 1) {
    return {
      native: byIdentity[0].native,
      match_criteria: "role+title",
      confidence: "heuristic",
    };
  }
  return null;
}

function buildFromElement(element, state) {
  const resolution = {
    app_ref: appRefFromState(state),
    isElement: true,
    kind: "element",
    observedValue: element.value,
  };
  if (typeof element.native === "string" && element.native) {
    resolution.native = element.native;
  }
  const bounds = element.bounds ?? [0, 0, 0, 0];
  const [, , bw, bh] = bounds;
  if (bw > 0 && bh > 0) {
    resolution.point = visibleElementCenter(bounds, state.window?.bounds ?? [0, 0, 0, 0]);
  }
  if (!resolution.point && !resolution.native) {
    throw new TargetResolveError(
      "element_no_native_no_bounds",
      `element has no native token and no on-screen bounds visible inside the observed window (element=${JSON.stringify(bounds)}, window=${JSON.stringify(state.window?.bounds ?? [])}); call get_app_state again and pick a visible element.`,
      state.state_id,
    );
  }
  resolution.fingerprint = {
    bounds,
    native: resolution.native ?? "",
  };
  return resolution;
}

/** 坐标目标:显式 frame_id 或隐式最新可动作帧,投影后返回 {frame_id, point}。 */
export function resolveCoordinateTarget(session, target) {
  const implicit = !target.frame_id;
  try {
    const frame = implicit
      ? session.frames.resolveLatestForAction()
      : session.frames.resolveForAction(target.frame_id);
    return {
      frame_id: frame.frame_id,
      point: projectFramePixelToPointer(frame, { x: target.x, y: target.y }),
      frame,
    };
  } catch (error) {
    if (error instanceof TargetResolveError) throw error;
    throw new TargetResolveError(
      "frame_reference_invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** helper 的 frame_provenance 载荷(逐字段对齐官方 frameActionProvenance)。 */
export function frameProvenanceFor(frame, target, point, endpointIndex = 0) {
  return {
    contract: "frame_pixel_projection_v1",
    frame_id: frame.frame_id,
    expires_at_ms: frame.expires_at_ms,
    delivered: { width: frame.delivered.width, height: frame.delivered.height },
    source: frame.source,
    pointer: frame.pointer,
    app: frame.app,
    window: frame.window,
    display: {
      display_id: frame.display?.display_id ?? null,
      topology_fingerprint: frame.display?.topology_fingerprint ?? "unverified",
    },
    capture_windows: frame.capture_windows ?? null,
    capture_surfaces: frame.capture_surfaces ?? null,
    pixel: { x: target.x, y: target.y },
    projected_point: point,
    endpoint_index: endpointIndex,
  };
}
