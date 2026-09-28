// B2 内部模块:工具结果 envelope 装配(CUA_NOT_READY 信封、动作收据、app-associations meta、
// AX 树文本渲染)。形状对齐官方 producer(node-repl-host 108716-108800 / 112087-112400 内联)
// 与 vendored SDK(computer-use-client.mjs)的 appStateOf/receiptOf/notReadyEnvelopeOf 解析面。
import { CUA_APP_ASSOCIATIONS_META_KEY, CUA_APP_ASSOCIATIONS_MAX_META_BYTES } from "../host-display-contract.js";

// ───────────────────────────────── CUA_NOT_READY 信封(官方文案逐字保留) ─────────────────────────────────

export const CUA_NOT_READY_KIND = "CUA_NOT_READY";
export const REASON_BROKER_NOT_ACCEPTING = "broker_not_accepting";
export const REASON_PERMISSION_REFRESH_IN_PROGRESS = "permission_refresh_in_progress";
export const REASON_PERMISSION_REFRESH_INVALID = "permission_refresh_invalid";
export const REASON_BROKER_RESPONSE_AMBIGUOUS = "broker_response_ambiguous";
export const REASON_CALLER_TIMEOUT = "caller_timeout";
export const REASON_RESTART_DEFERRED_ACTIVE_TURN = "restart_deferred_active_turn";

export const NOT_READY_MESSAGE =
  "The ZCode Computer Use is starting up and its permission broker socket is not accepting connections yet. Retry the same tool call after a brief wait.";
export const BROKER_RESPONSE_AMBIGUOUS_MESSAGE =
  "The Helper may have accepted this action, but its response was lost. Do not replay it automatically; observe the target state first.";
export const PERMISSION_REFRESH_IN_PROGRESS_MESSAGE =
  "ZCode is still refreshing the permission Helper. Retry after the refresh finishes.";
export const PERMISSION_REFRESH_INVALID_MESSAGE =
  "ZCode's permission refresh marker is invalid or unsafe. ZCode must recreate the marker in its private runtime directory.";

const REASON_MESSAGE = Object.freeze({
  [REASON_BROKER_NOT_ACCEPTING]: NOT_READY_MESSAGE,
  [REASON_BROKER_RESPONSE_AMBIGUOUS]: BROKER_RESPONSE_AMBIGUOUS_MESSAGE,
  [REASON_PERMISSION_REFRESH_IN_PROGRESS]: PERMISSION_REFRESH_IN_PROGRESS_MESSAGE,
  [REASON_PERMISSION_REFRESH_INVALID]: PERMISSION_REFRESH_INVALID_MESSAGE,
});

const NOT_READY_DETAILS_KEYS = Object.freeze([
  "socket_path",
  "error_type",
  "refresh_marker_state",
  "refresh_marker_retryable",
  "rpc_deadline_state",
  "rotation_state",
  "broker_response_state",
  "request_delivery_state",
]);

export function cuaNotReadyPayload(options = {}) {
  const reasonCode = options.reasonCode ?? REASON_BROKER_NOT_ACCEPTING;
  const payload = {
    kind: CUA_NOT_READY_KIND,
    reasonCode,
    retryable: options.retryable ?? true,
    message: options.message ?? REASON_MESSAGE[reasonCode] ?? NOT_READY_MESSAGE,
  };
  if (options.details !== undefined) {
    payload.details = { ...options.details };
  }
  return payload;
}

/**
 * broker 不可用异常 → CUA_NOT_READY 载荷(request_delivery_state==="possibly_sent" 即
 * broker_response_ambiguous,retryable:false——绝不重放非幂等动作)。
 */
export function notReadyPayloadForDelivery(details = {}, toolName) {
  const picked = { tool: toolName };
  for (const key of NOT_READY_DETAILS_KEYS) {
    if (details[key] !== undefined) picked[key] = details[key];
  }
  if (details.request_delivery_state === "possibly_sent") {
    return cuaNotReadyPayload({
      reasonCode: REASON_BROKER_RESPONSE_AMBIGUOUS,
      retryable: false,
      details: picked,
    });
  }
  return cuaNotReadyPayload({ reasonCode: REASON_BROKER_NOT_ACCEPTING, retryable: true, details: picked });
}

// ───────────────────────────────── 基础 envelope ─────────────────────────────────

export function textResult(text, extra = {}) {
  return { content: [{ type: "text", text }], ...extra };
}

export function jsonResult(payload, extra = {}) {
  return textResult(JSON.stringify(payload), extra);
}

/**
 * 失败结果:文本 + 结构化 code(SDK 的 brokerErrorCodeOf 从 JSON 文本块或收据读 code)。
 * `CONTROL_STOPPED` 是工具层合成码(broker 无此码,规格 §6.1);消息里同时携带码文本,
 * 兼容只透传 message 的展示路径。
 */
export function toolError(message, options = {}) {
  const code = options.code;
  const text = code === "CONTROL_STOPPED" && !message.includes("CONTROL_STOPPED")
    ? `CONTROL_STOPPED: ${message}`
    : message;
  return {
    isError: true,
    content: [{ type: "text", text }],
    ...(code
      ? {
          structuredContent: {
            code,
            message: text,
            ...(options.details ? { details: options.details } : {}),
          },
        }
      : {}),
  };
}

export function subagentUnavailableResult() {
  return {
    isError: true,
    content: [{ type: "text", text: "Computer Use is not available in subagent" }],
    structuredContent: { code: "SUBAGENT_COMPUTER_USE_UNAVAILABLE" },
  };
}

export function notReadyResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

// ───────────────────────────────── app-associations meta ─────────────────────────────────

/**
 * `deriveApplicationKey` 官方形态(packages/ui/src/lib/cuaAppIconRequest.ts 消费):
 * `darwin:<bundleId 小写>` / `windows-aumid:<aumid>` / `windows-exe:<canonical path>` / `linux-exe:<path>`。
 */
export function deriveApplicationKey(app, platform = process.platform) {
  if (!app || typeof app !== "object") return undefined;
  const bundleId = typeof app.bundle_id === "string" ? app.bundle_id.trim().toLowerCase() : "";
  const aumid = typeof app.aumid === "string" ? app.aumid.trim() : "";
  const exe = typeof app.executable_path === "string" ? app.executable_path.trim() : "";
  if (platform === "darwin") {
    return bundleId ? `darwin:${bundleId}` : undefined;
  }
  if (platform === "win32") {
    if (aumid) return `windows-aumid:${aumid}`;
    return exe ? `windows-exe:${exe}` : undefined;
  }
  return exe ? `linux-exe:${exe}` : undefined;
}

export function appIdentityOf(app, platform = process.platform) {
  const appKey = deriveApplicationKey(app, platform);
  if (!appKey) return undefined;
  const displayName = typeof app?.name === "string" && app.name.trim() ? app.name.trim() : undefined;
  return { appKey, ...(displayName ? { displayName } : {}) };
}

/**
 * 附上 `_meta["zcode.cua/app-associations-v1"]`(桥跳按 primary 摘取为目标应用身份)。
 * mode: primary(动作/观察)/items(list_apps 按下标关联)/none(request_access、stop)。
 */
export function attachAppAssociationsMeta(result, mode, apps, platform = process.platform) {
  if (mode === "none") return result;
  const list = (Array.isArray(apps) ? apps : [apps])
    .map((app) => appIdentityOf(app, platform))
    .filter(Boolean);
  const associations =
    mode === "items" ? { items: list } : list[0] ? { primary: list[0] } : undefined;
  if (!associations) return result;
  const meta = { [CUA_APP_ASSOCIATIONS_META_KEY]: associations };
  // meta 上限 16KiB(R14):超限直接放弃 meta,不让工具结果被截断。
  if (Buffer.byteLength(JSON.stringify(meta), "utf8") > CUA_APP_ASSOCIATIONS_MAX_META_BYTES) {
    return result;
  }
  return { ...result, _meta: { ...result._meta, ...meta } };
}

// ───────────────────────────────── AX 树文本渲染 ─────────────────────────────────

const UBIQUITOUS_ACTIONS = new Set(["AXScrollToVisible"]);

function flag(value, label) {
  return value ? label : "";
}

function roleLabel(el) {
  if (el.kind) return el.kind;
  const role = (el.role ?? "").trim();
  if (!role) return "element";
  return (role.startsWith("AX") ? role.slice(2) : role).toLowerCase() || "element";
}

function stripPointerNoise(title) {
  return title
    .replaceAll(/<0x[0-9a-f]+>/gu, "")
    .replaceAll(/(?:^|\s)_NS:\d+(?=\s|$)/gu, " ")
    .replaceAll(/\s{2,}/gu, " ")
    .trim();
}

function sanitizeActionName(action) {
  const named = /(?:^|\n)Name:\s*([^\n]+)/u.exec(action);
  if (named?.[1]) return named[1].trim();
  return action.replaceAll(/\s*\n\s*/gu, " ").trim();
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function elementRow(index, el) {
  const caps = [
    flag(el.pressable, "pressable"),
    flag(el.editable, "editable"),
    flag(el.has_menu, "has_menu"),
    flag(el.focused, "focused"),
    flag(el.selected === true, "selected"),
    flag(el.default_action === true, "default_action"),
    flag(!el.enabled, "disabled"),
  ]
    .filter(Boolean)
    .join(" ");
  const cleanTitle = el.title ? stripPointerNoise(el.title) : "";
  const title = cleanTitle ? ` ${cleanTitle}` : "";
  const value = el.value ? ` = ${truncate(el.value, 60)}` : "";
  const head = `[${index}] ${roleLabel(el)}${title}${value}`;
  const tail = caps ? ` (${caps})` : "";
  const total = el.children_total;
  const sampled = (() => {
    if (typeof total !== "number" || total <= 0) return "";
    const shown = el.children_shown ?? 0;
    const offset = el.children_offset ?? 0;
    const range = shown > 0 ? `${offset}-${offset + shown - 1}` : `${shown}`;
    return ` (showing ${range} of ${total} items)`;
  })();
  const semanticActions = (el.actions ?? [])
    .filter((action) => !UBIQUITOUS_ACTIONS.has(action))
    .map(sanitizeActionName)
    .filter(Boolean);
  const actions = semanticActions.length ? ` actions=[${semanticActions.join(",")}]` : "";
  const indent = " ".repeat(1 + Math.min(el.depth ?? 0, 24));
  return `${indent}${head}${tail}${sampled}${actions}`;
}

const EMPTY_CAPTURE_GUIDANCE = {
  "cg-only-no-ax-window":
    "This app has closed all of its real windows — the window_id above is a WindowServer leftover that is neither visible to the user nor readable through Accessibility. Do NOT retry this read. Either drive the app's menu bar (its items are listed below, e.g. File > New) or reopen the app to get a real window back.",
  "ax-window-empty-tree":
    "A window resolved but exposed no Accessibility children — the app may be busy or still building its tree. Take a screenshot to see what is actually on screen, or call list_windows to pick a different window before reading again.",
};

function elementPriority(el, windowBounds) {
  let score = 0;
  const kind = (el.kind ?? "").toLowerCase();
  const container = /group|split|scroll|layout|container|pane|unknown/.test(kind);
  const leafControl = /button|check|radio|switch|link|menuitem|tab|textfield|textarea|slider/.test(kind);
  if (el.focused) score += 220;
  if (el.selected) score += 240;
  if (el.default_action) score += 240;
  if (el.pressable && el.enabled) score += 200;
  if (leafControl) score += 100;
  if (el.title) score += 60;
  if (el.editable && !container) score += 120;
  if (el.has_menu && !container) score += 30;
  if (el.value) score += 20;
  if (container) score -= 120;
  const [, , ew, eh] = el.bounds ?? [0, 0, 0, 0];
  const [, , ww, wh] = windowBounds ?? [0, 0, 0, 0];
  if (ew <= 0 || eh <= 0) score -= kind === "menuitem" ? 50 : 400;
  if (ww > 0 && wh > 0 && ew * eh >= ww * wh * 0.75) score -= 80;
  return score;
}

/** 观察结果的树文本(app/window 头 + 元素行;超过上限按优先级裁剪,索引保持稀疏可见)。 */
export function formatAppStateTree(state) {
  const app = state.app ?? {};
  const win = state.window ?? {};
  const appParts = [];
  if (app.bundle_id) appParts.push(app.bundle_id);
  if (typeof app.pid === "number") appParts.push(`pid=${app.pid}`);
  if (app.name) appParts.push(`"${app.name}"`);
  const appLine = appParts.length ? appParts.join(" ") : "(unknown app)";
  const [wx, wy, ww, wh] = win.bounds ?? [0, 0, 0, 0];
  const title = win.title ? ` "${win.title}"` : "";
  const windowId = typeof win.window_id === "number" ? ` window_id=${win.window_id}` : "";
  const fallbackNote = win.window_id_fallback
    ? `[window_id_fallback] ${win.note ?? "The requested window could not be resolved; a different live window was returned. Call list_windows before acting."}`
    : "";
  const emptyCaptureNote = win.empty_capture_reason
    ? `[${win.empty_capture_reason}] ${EMPTY_CAPTURE_GUIDANCE[win.empty_capture_reason] ?? "This app exposed no window tree. Retrying the same read is unlikely to help; re-resolve the app with list_windows first."}`
    : "";
  const surfaceLine = win.surface_kind
    ? `surface: kind=${win.surface_kind} actual_window_id=${win.actual_window_id ?? win.window_id ?? "unknown"} presentation_window_id=${win.presentation_window_id ?? win.window_id ?? "unknown"} lifecycle=${win.surface_lifecycle ?? "stable"}`
    : "";
  const maxElements = (() => {
    const raw = Number.parseInt(process.env.ZCODE_CUA_MAX_ELEMENTS ?? "", 10);
    return Number.isInteger(raw) && raw >= 50 && raw <= 4000 ? raw : 1500;
  })();
  let entries = state.elements.map((el, index) => ({ el, index }));
  let truncatedCount = 0;
  if (entries.length > maxElements) {
    const ranked = entries.map(({ el, index }) => ({ el, index, score: elementPriority(el, win.bounds) }));
    ranked.sort((a, b) => b.score - a.score);
    const keep = new Set(ranked.slice(0, maxElements).map((entry) => entry.index));
    for (const index of Array.from(keep)) {
      let wanted = (state.elements[index]?.depth ?? 0) - 1;
      for (let j = index - 1; j >= 0 && wanted >= 0; j -= 1) {
        if ((state.elements[j]?.depth ?? 0) === wanted) {
          keep.add(j);
          wanted -= 1;
        }
      }
    }
    entries = [...keep]
      .sort((a, b) => a - b)
      .map((index) => ({ el: state.elements[index], index }));
    truncatedCount = state.elements.length - entries.length;
  }
  const rows = entries.map(({ el, index }) => elementRow(index, el));
  const truncatedNote =
    truncatedCount > 0
      ? `note: ${entries.length} of ${state.elements.length} elements shown (selected by priority, ancestors kept) — indices are sparse; ${truncatedCount} hidden`
      : "";
  return [
    `app: ${appLine}`,
    `window:${title}${windowId} bounds=[${wx},${wy},${ww},${wh}]`,
    surfaceLine,
    fallbackNote,
    emptyCaptureNote,
    truncatedNote,
    `elements (${entries.length}${truncatedCount > 0 ? ` of ${state.elements.length}` : ""}):`,
    ...rows,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/** `image_ref` 文本块:官方精确形状(键集 actionable,frame_id,height,width)。 */
export function imageRefBlockText(imageRef) {
  return JSON.stringify({ image_ref: imageRef });
}

export const SCREENSHOT_UNAVAILABLE_NOTE_PREFIX = "[screenshot unavailable:";

export function effectEvidenceText(effectEvidence) {
  return typeof effectEvidence === "string" && effectEvidence
    ? `[effect_evidence ${effectEvidence}]`
    : "";
}
