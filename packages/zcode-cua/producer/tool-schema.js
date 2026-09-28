/* eslint-disable max-lines -- 14 工具的严格 schema 是一张对照表(与官方 zod 定义逐字段对齐),按工具拆文件会让 unrecognized_keys/默认值规则失去机械对照面。 */
// B2 内部模块:14 工具的严格 schema(未声明键拒绝)。字段/默认值逐一对齐官方 zod 定义
// (node-repl-host 111440-111803):app_ref 字符串归一 {bundle_id}、target 二态、
// stringified JSON 数组宽容解析、key token 校验、hold_seconds/scroll_amount 边界。

export class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaError";
    this.code = "invalid_request";
  }
}

function expectPlainObject(value, what) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new SchemaError(`${what} must be an object`);
  }
  return value;
}

function rejectUnknownKeys(record, allowed, what) {
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new SchemaError(`unrecognized_keys: ${unexpected.join(", ")} (in ${what})`);
  }
}

export function parseAppRef(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new SchemaError("app_ref bundle id string must be non-empty");
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      throw new SchemaError(
        `app_ref must be a bundle id string (e.g. com.example.App) or an object {bundle_id|pid}; a JSON-stringified value like '${trimmed}' is not a valid bundle id. Pass the parsed object instead.`,
      );
    }
    return { bundle_id: value };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new SchemaError("app_ref must be an object {bundle_id|pid} or a bundle id string");
  }
  rejectUnknownKeys(value, new Set(["bundle_id", "pid", "window_id", "name"]), "app_ref");
  const result = {};
  if (value.bundle_id !== undefined && value.bundle_id !== null) {
    if (typeof value.bundle_id !== "string" || !value.bundle_id.trim()) {
      throw new SchemaError("app_ref.bundle_id must be a non-empty string");
    }
    result.bundle_id = value.bundle_id;
  }
  if (value.pid !== undefined && value.pid !== null) {
    if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) {
      throw new SchemaError("app_ref.pid must be a positive integer");
    }
    result.pid = value.pid;
  }
  if (value.window_id !== undefined && value.window_id !== null) {
    if (typeof value.window_id !== "number" || !Number.isInteger(value.window_id)) {
      throw new SchemaError("app_ref.window_id must be an integer");
    }
    result.window_id = value.window_id;
  }
  if (value.name !== undefined && value.name !== null) {
    if (typeof value.name !== "string" || !value.name.trim()) {
      throw new SchemaError("app_ref.name must be a non-empty string");
    }
    result.name = value.name;
  }
  return result;
}

function parsePixel(value, name) {
  if (typeof value === "boolean" || typeof value !== "number") {
    throw new SchemaError(`${name} must be a number`);
  }
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new SchemaError(`${name} must be an integer pixel index`);
  }
  return value;
}

export function parseTarget(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SchemaError('target must be an object with a "type" of "element" or "coordinate"');
  }
  const kind = value.type;
  if (kind === "element") {
    if (value.frame_id !== undefined) {
      throw new SchemaError(
        'element target must not carry frame_id; frame_id belongs to {"type":"coordinate"} image-pixel targets. Use an element index, or a coordinate target.',
      );
    }
    rejectUnknownKeys(value, new Set(["type", "index"]), "element target");
    const index = value.index;
    if (typeof index === "boolean" || typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      throw new SchemaError("element target requires a non-negative integer index");
    }
    return { type: "element", index };
  }
  if (kind === "coordinate") {
    rejectUnknownKeys(value, new Set(["type", "frame_id", "x", "y"]), "coordinate target");
    if (value.frame_id !== undefined && (typeof value.frame_id !== "string" || value.frame_id.length === 0)) {
      throw new SchemaError("coordinate target frame_id, when provided, must be a non-empty string");
    }
    return {
      type: "coordinate",
      ...(typeof value.frame_id === "string" ? { frame_id: value.frame_id } : {}),
      x: parsePixel(value.x, "target.x"),
      y: parsePixel(value.y, "target.y"),
    };
  }
  throw new SchemaError('target.type must be "element" or "coordinate"');
}

function parseTargetRequired(value) {
  if (value === undefined || value === null) {
    throw new SchemaError("target is required");
  }
  return parseTarget(value);
}

function parseStringifiedArray(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return value;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function enumOf(value, allowed, name, fallback) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new SchemaError(`${name} is required`);
  }
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new SchemaError(`${name} must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`);
  }
  return value;
}

function intOf(value, name, { fallback, nullable = false, min, max } = {}) {
  if (value === undefined || value === null) {
    if (nullable) return value ?? null;
    if (fallback !== undefined) return fallback;
    throw new SchemaError(`${name} is required`);
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new SchemaError(`${name} must be an integer`);
  }
  if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
    throw new SchemaError(`${name} must be within [${min ?? "-inf"}, ${max ?? "+inf"}]`);
  }
  return value;
}

function floatOf(value, name, { nullable = false, fallback } = {}) {
  if (value === undefined || value === null) {
    if (nullable) return value ?? null;
    if (fallback !== undefined) return fallback;
    throw new SchemaError(`${name} is required`);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SchemaError(`${name} must be a finite number`);
  }
  return value;
}

function stringOf(value, name, { nullable = false, fallback } = {}) {
  if (value === undefined || value === null) {
    if (nullable) return value ?? null;
    if (fallback !== undefined) return fallback;
    throw new SchemaError(`${name} is required`);
  }
  if (typeof value !== "string") throw new SchemaError(`${name} must be a string`);
  return value;
}

function boolOf(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new SchemaError(`${name} must be a boolean`);
  return value;
}

const STRATEGIES = ["auto", "a11y", "event"];
const RETURN_STATES = ["none", "compact", "full"];
const MOUSE_BUTTONS = ["left", "right", "middle"];
const SCROLL_DIRECTIONS = ["up", "down", "left", "right"];
const PASTE_FORMATS = ["text", "md", "html"];

const PUBLIC_KEY_TOKENS = new Set([
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
  "=",
  "*",
  "-",
  "]",
  "[",
  "'",
  ";",
  "\\",
  ",",
  "/",
  ".",
  "`",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "esc",
  "escape",
  "cmd",
  "command",
  "meta",
  "super",
  "win",
  "shift",
  "capslock",
  "alt",
  "opt",
  "option",
  "ctrl",
  "control",
  "help",
  "home",
  "pageup",
  "forwarddelete",
  "end",
  "pagedown",
  "left",
  "right",
  "down",
  "up",
  ...Array.from({ length: 16 }, (_, index) => `f${index + 1}`),
]);

export function findUnsupportedKeyToken(text) {
  const tokens = text
    .split("+")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token && token !== "none");
  return tokens.find((token) => !PUBLIC_KEY_TOKENS.has(token)) ?? null;
}

function commonPointer(record) {
  return {
    modifiers: stringOf(record.modifiers, "modifiers", { fallback: "" }).trim(),
    strategy: enumOf(record.strategy, STRATEGIES, "strategy", "auto"),
    return_state: enumOf(record.return_state, RETURN_STATES, "return_state", "none"),
    app_ref: parseAppRef(record.app_ref),
  };
}

/** 14 工具的严格解析;返回 handler 使用的规范化参数对象。 */
export function parseToolArguments(toolName, raw) {
  const record = expectPlainObject(raw, `${toolName} arguments`);
  switch (toolName) {
    case "list_apps":
      rejectUnknownKeys(record, new Set(), "list_apps");
      return {};
    case "list_windows": {
      rejectUnknownKeys(record, new Set(["app_ref"]), "list_windows");
      const appRef = parseAppRef(record.app_ref);
      if (!appRef) throw new SchemaError("list_windows requires app_ref");
      return { app_ref: appRef };
    }
    case "get_app_state": {
      rejectUnknownKeys(
        record,
        new Set(["app_ref", "include_screenshot", "disable_diffing", "tree_shown_to_model"]),
        "get_app_state",
      );
      const appRef = parseAppRef(record.app_ref);
      if (!appRef) throw new SchemaError("get_app_state requires app_ref");
      return {
        app_ref: appRef,
        include_screenshot: boolOf(record.include_screenshot, "include_screenshot", false),
        disable_diffing: boolOf(record.disable_diffing, "disable_diffing", false),
        tree_shown_to_model: boolOf(record.tree_shown_to_model, "tree_shown_to_model", true),
      };
    }
    case "left_click": {
      rejectUnknownKeys(
        record,
        new Set(["target", "modifiers", "strategy", "return_state", "app_ref", "mouse_button", "click_count"]),
        "left_click",
      );
      return {
        target: parseTargetRequired(record.target),
        ...commonPointer(record),
        mouse_button: enumOf(record.mouse_button, MOUSE_BUTTONS, "mouse_button", "left"),
        click_count: intOf(record.click_count, "click_count", { fallback: 1, min: 1 }),
      };
    }
    case "scroll": {
      rejectUnknownKeys(
        record,
        new Set(["target", "scroll_direction", "scroll_amount", "strategy", "return_state", "app_ref"]),
        "scroll",
      );
      return {
        target: parseTargetRequired(record.target),
        scroll_direction: enumOf(record.scroll_direction, SCROLL_DIRECTIONS, "scroll_direction"),
        scroll_amount: intOf(record.scroll_amount, "scroll_amount"),
        ...commonPointer(record),
      };
    }
    case "left_click_drag": {
      rejectUnknownKeys(
        record,
        new Set(["from_target", "to", "modifiers", "return_state", "app_ref"]),
        "left_click_drag",
      );
      return {
        from_target: parseTargetRequired(record.from_target),
        to: parseTargetRequired(record.to),
        modifiers: stringOf(record.modifiers, "modifiers", { fallback: "" }).trim(),
        return_state: enumOf(record.return_state, RETURN_STATES, "return_state", "none"),
        app_ref: parseAppRef(record.app_ref),
      };
    }
    case "type": {
      rejectUnknownKeys(
        record,
        new Set(["text", "target", "app_ref", "strategy", "return_state"]),
        "type",
      );
      return {
        text: stringOf(record.text, "text"),
        target: record.target === undefined || record.target === null ? undefined : parseTarget(record.target),
        ...commonPointer(record),
      };
    }
    case "set_value": {
      rejectUnknownKeys(
        record,
        new Set(["target", "value", "strategy", "return_state", "app_ref"]),
        "set_value",
      );
      return {
        target: parseTargetRequired(record.target),
        value: stringOf(record.value, "value"),
        ...commonPointer(record),
      };
    }
    case "select_text": {
      rejectUnknownKeys(
        record,
        new Set(["target", "text_range", "return_state", "app_ref"]),
        "select_text",
      );
      const rangeRaw = parseStringifiedArray(record.text_range);
      let text_range;
      if (rangeRaw !== undefined && rangeRaw !== null) {
        if (
          !Array.isArray(rangeRaw) ||
          rangeRaw.length !== 2 ||
          rangeRaw.some((part) => typeof part !== "number" || !Number.isInteger(part))
        ) {
          throw new SchemaError("text_range must be a [start, length] integer pair");
        }
        text_range = rangeRaw;
      }
      return {
        target: parseTargetRequired(record.target),
        text_range,
        return_state: enumOf(record.return_state, RETURN_STATES, "return_state", "none"),
        app_ref: parseAppRef(record.app_ref),
      };
    }
    case "key": {
      rejectUnknownKeys(
        record,
        new Set(["text", "repeat", "hold_seconds", "app_ref", "strategy", "return_state"]),
        "key",
      );
      const text = stringOf(record.text, "text");
      const unsupported = findUnsupportedKeyToken(text);
      if (unsupported) {
        throw new SchemaError(`unsupported_key_token: ${unsupported}`);
      }
      return {
        text,
        repeat: intOf(record.repeat, "repeat", { nullable: true, min: 1 }),
        hold_seconds: floatOf(record.hold_seconds, "hold_seconds", { nullable: true }),
        ...commonPointer(record),
      };
    }
    case "perform_action": {
      rejectUnknownKeys(
        record,
        new Set(["target", "action", "return_state", "app_ref"]),
        "perform_action",
      );
      return {
        target: parseTargetRequired(record.target),
        action: stringOf(record.action, "action"),
        return_state: enumOf(record.return_state, RETURN_STATES, "return_state", "none"),
        app_ref: parseAppRef(record.app_ref),
      };
    }
    case "paste": {
      rejectUnknownKeys(
        record,
        new Set(["text", "format", "app_ref", "return_state"]),
        "paste",
      );
      return {
        text: stringOf(record.text, "text"),
        format: enumOf(record.format, PASTE_FORMATS, "format", "text"),
        return_state: enumOf(record.return_state, RETURN_STATES, "return_state", "none"),
        app_ref: parseAppRef(record.app_ref),
      };
    }
    case "request_access": {
      rejectUnknownKeys(record, new Set(["capabilities"]), "request_access");
      const capabilities = parseStringifiedArray(record.capabilities);
      if (capabilities !== undefined && capabilities !== null) {
        if (!Array.isArray(capabilities) || capabilities.some((entry) => typeof entry !== "string")) {
          throw new SchemaError("capabilities must be an array of strings");
        }
      }
      return { capabilities: capabilities ?? undefined };
    }
    case "stop_computer_control": {
      rejectUnknownKeys(record, new Set(["reason"]), "stop_computer_control");
      return { reason: stringOf(record.reason, "reason", { nullable: true }) };
    }
    default:
      throw new SchemaError(`Unknown tool: ${toolName}`);
  }
}

export const TOOL_NAMES = Object.freeze([
  "list_apps",
  "list_windows",
  "get_app_state",
  "left_click",
  "scroll",
  "left_click_drag",
  "type",
  "set_value",
  "select_text",
  "key",
  "perform_action",
  "paste",
  "request_access",
  "stop_computer_control",
]);

/** 会改变 UI 的工具(possibly_sent 判定路径;settle 台账对象)。 */
export const MUTATING_TOOL_NAMES = new Set([
  "left_click",
  "scroll",
  "left_click_drag",
  "type",
  "set_value",
  "select_text",
  "key",
  "perform_action",
  "paste",
]);

export const APP_ASSOCIATION_MODE_BY_TOOL = Object.freeze({
  list_apps: "items",
  list_windows: "primary",
  get_app_state: "primary",
  left_click: "primary",
  scroll: "primary",
  left_click_drag: "primary",
  type: "primary",
  set_value: "primary",
  select_text: "primary",
  key: "primary",
  perform_action: "primary",
  paste: "primary",
  request_access: "none",
  stop_computer_control: "none",
});
