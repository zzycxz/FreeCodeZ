// B2 内部模块:capture_app 响应 → 会话观察状态的组装(元素归一、帧签发、栅格尺寸)。
// 形状对齐官方 ingestCaptureAppResult/issueCaptureFrame/asElements(node-repl-host
// 112087-112241);PNG 尺寸用 IHDR 直读(零依赖),sharp 可选用于大图降采样。
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { imageRefBlockText } from "./tool-envelope.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** PNG IHDR 直读宽高(16..24 大端);非 PNG 或损坏返回 null。 */
export function readPngSize(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
  if (buffer.length < 24 || buffer.subarray(0, 8).compare(PNG_SIGNATURE) !== 0) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

let sharpPromise;
function loadSharp() {
  if (!sharpPromise) {
    // sharp 从 CUA 插件资产的 node_modules 解析(B1-3 的 stage 白名单携带 koffi/sharp 链);
  // 缺失时降级为原尺寸栅格,不影响功能契约。
    const requireBases = [
      process.env.ZCODE_CUA_PLUGIN_ROOT ? join(process.env.ZCODE_CUA_PLUGIN_ROOT, "package.json") : undefined,
      typeof import.meta.url === "string" && import.meta.url ? import.meta.url : undefined,
      process.env.ZCODE_PLUGIN_ROOT ? join(process.env.ZCODE_PLUGIN_ROOT, "package.json") : undefined,
    ].filter((base) => typeof base === "string");
    sharpPromise = (async () => {
      let lastError;
      for (const requireBase of new Set(requireBases)) {
        try {
          const sharp = createRequire(requireBase)("sharp");
          if (typeof sharp === "function" && typeof sharp.versions?.vips === "string") return sharp;
          lastError = new Error("Resolved sharp runtime failed callable/libvips validation");
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new Error("sharp is unavailable");
    })();
  }
  return sharpPromise;
}

const MAX_EDGE = 1280;

/** 大图降采样(长边 ≤1280);sharp 不可用或图已够小时原样返回。 */
export async function downscaleScreenshot(pngBase64) {
  try {
    const size = readPngSize(Buffer.from(pngBase64, "base64"));
    if (!size || Math.max(size.width, size.height) <= MAX_EDGE) return pngBase64;
    const sharp = await loadSharp();
    const out = await sharp(Buffer.from(pngBase64, "base64")).resize({
      width: MAX_EDGE,
      height: MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    }).png({ compressionLevel: 9, palette: false, strip: true })
      .toBuffer();
    return out.toString("base64");
  } catch {
    return pngBase64;
  }
}

function asBounds(value, where) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error(`${where} must be a 4-number bounds array; got ${JSON.stringify(value)}`);
  }
  const nums = value.map(Number);
  if (!nums.every((n) => Number.isFinite(n))) {
    throw new Error(`${where} must contain finite numbers; got ${JSON.stringify(value)}`);
  }
  return nums;
}

export function asElements(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`capture_app element[${i}] must be an object; got ${typeof entry}`);
    }
    const bounds = asBounds(entry.bounds, `capture_app element[${i}].bounds`);
    const actions = Array.isArray(entry.actions) ? entry.actions : [];
    return {
      role: typeof entry.role === "string" ? entry.role : "",
      kind: typeof entry.kind === "string" ? entry.kind : "",
      title: typeof entry.title === "string" ? entry.title : null,
      value: typeof entry.value === "string" ? entry.value : null,
      bounds,
      enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
      editable: typeof entry.editable === "boolean" ? entry.editable : false,
      actions,
      focused: typeof entry.focused === "boolean" ? entry.focused : false,
      ...(typeof entry.selected === "boolean" ? { selected: entry.selected } : {}),
      default_action: typeof entry.default_action === "boolean" ? entry.default_action : false,
      pressable: typeof entry.pressable === "boolean" ? entry.pressable : actions.includes("AXPress"),
      has_menu: typeof entry.has_menu === "boolean" ? entry.has_menu : actions.includes("AXShowMenu"),
      native: typeof entry.native === "string" ? entry.native : "",
      owner_pid: typeof entry.owner_pid === "number" ? entry.owner_pid : null,
      ...(typeof entry.depth === "number" ? { depth: entry.depth } : {}),
      ...(typeof entry.children_total === "number" && entry.children_total > 0
        ? {
            children_total: entry.children_total,
            ...(typeof entry.children_shown === "number" ? { children_shown: entry.children_shown } : {}),
          }
        : {}),
    };
  });
}

function asSurfaceKind(value) {
  return ["window", "attached_dialog", "open_panel", "save_panel", "popover"].includes(value)
    ? value
    : "window";
}

/**
 * capture_app 响应 → 观察状态 + 帧凭据。screenshot 存在且几何可信时签发帧
 * (frame_pixel_projection_v1),产出 image_ref 文本块载荷。
 */
export async function ingestCaptureAppResult(session, raw, options = {}) {
  const app = {
    bundle_id: typeof raw.app?.bundle_id === "string" ? raw.app.bundle_id : null,
    pid: typeof raw.app?.pid === "number" ? raw.app.pid : null,
    name: typeof raw.app?.name === "string" ? raw.app.name : null,
    window_id: typeof raw.window?.window_id === "number" ? raw.window.window_id : null,
    aumid: typeof raw.app?.aumid === "string" ? raw.app.aumid : null,
    executable_path: typeof raw.app?.executable_path === "string" ? raw.app.executable_path : null,
    icon_png: typeof raw.app?.icon_png === "string" ? raw.app.icon_png : null,
  };
  const window = {
    title: typeof raw.window?.title === "string" ? raw.window.title : null,
    bounds: raw.window?.bounds ? asBounds(raw.window.bounds, "capture_app window.bounds") : [0, 0, 0, 0],
    window_id: typeof raw.window?.window_id === "number" ? raw.window.window_id : null,
    window_id_fallback: raw.window?.window_id_fallback === true || undefined,
    empty_capture_reason:
      typeof raw.window?.empty_capture_reason === "string" && raw.window.empty_capture_reason
        ? raw.window.empty_capture_reason
        : undefined,
    note:
      raw.window?.window_id_fallback === true && typeof raw.window?.note === "string"
        ? raw.window.note
        : undefined,
    actual_window_id:
      typeof raw.window?.actual_window_id === "number"
        ? raw.window.actual_window_id
        : (typeof raw.window?.window_id === "number" ? raw.window.window_id : null),
    presentation_window_id:
      typeof raw.window?.presentation_window_id === "number"
        ? raw.window.presentation_window_id
        : (typeof raw.window?.window_id === "number" ? raw.window.window_id : null),
    surface_kind: asSurfaceKind(raw.window?.surface_kind),
    surface_lifecycle:
      raw.window?.surface_lifecycle === "replaced" || raw.window?.surface_lifecycle === "closed"
        ? raw.window.surface_lifecycle
        : "stable",
  };
  const elements = asElements(raw.elements);
  const screenshotBlank = raw.screenshot_blank === true;
  const screenshotData = raw.screenshot?.data;
  const rasterSize = screenshotData ? readPngSize(Buffer.from(screenshotData, "base64")) : null;
  const state = {
    state_id:
      typeof raw.state_id === "string" && raw.state_id ? raw.state_id : session.nextStateId(),
    app,
    window,
    elements,
    has_image: !screenshotBlank && rasterSize !== null,
    image_size: screenshotBlank ? undefined : (rasterSize ?? undefined),
    screenshot_blank: screenshotBlank || undefined,
    ...(typeof raw.snapshot_mode === "string" ? { snapshot_mode: raw.snapshot_mode } : {}),
    ...(typeof raw.base_state_id === "string" ? { base_state_id: raw.base_state_id } : {}),
    ...(raw.changes !== undefined ? { changes: raw.changes } : {}),
  };

  let screenshotBase64;
  if (screenshotData && !screenshotBlank) {
    screenshotBase64 = await downscaleScreenshot(screenshotData);
    const deliveredSize = readPngSize(Buffer.from(screenshotBase64, "base64")) ?? rasterSize;
    const pointer = raw.pointer;
    const geometryVerified =
      raw.coordinate_contract === "frame_pixel_projection_v1" &&
      pointer !== null &&
      pointer !== undefined &&
      [pointer.x, pointer.y, pointer.width, pointer.height].every(
        (part) => typeof part === "number" && Number.isFinite(part),
      ) &&
      (pointer.width ?? 0) > 0 &&
      (pointer.height ?? 0) > 0 &&
      typeof pointer.unit === "string" &&
      typeof raw.display?.topology_fingerprint === "string" &&
      raw.display.topology_fingerprint.length > 0;
    const nonActionableReason = screenshotBlank
      ? "screenshot_blank"
      : geometryVerified
        ? null
        : "capture_geometry_unverified";
    const frame = session.frames.issue({
      delivered: {
        width: deliveredSize.width,
        height: deliveredSize.height,
        format: "png",
        digest: `sha256:${createHash("sha256").update(Buffer.from(screenshotBase64, "base64")).digest("hex")}`,
        data: screenshotBase64,
      },
      source: {
        width: rasterSize?.width ?? deliveredSize.width,
        height: rasterSize?.height ?? deliveredSize.height,
        crop: {
          left: 0,
          top: 0,
          right: rasterSize?.width ?? deliveredSize.width,
          bottom: rasterSize?.height ?? deliveredSize.height,
        },
      },
      pointer: {
        x: pointer?.x ?? 0,
        y: pointer?.y ?? 0,
        width: pointer?.width ?? 0,
        height: pointer?.height ?? 0,
        unit: pointer?.unit ?? "point",
      },
      app,
      window: { window_id: window.window_id, bounds: window.bounds },
      display: {
        display_id: raw.display?.id ?? null,
        topology_fingerprint: raw.display?.topology_fingerprint ?? "unverified",
        origin: { x: pointer?.x ?? 0, y: pointer?.y ?? 0 },
      },
      capture_surfaces: raw.capture_surfaces ?? null,
      actionable: nonActionableReason === null,
      non_actionable_reason: nonActionableReason,
    });
    state.image_ref = {
      frame_id: frame.frame_id,
      width: frame.delivered.width,
      height: frame.delivered.height,
      actionable: frame.actionable,
    };
    if (nonActionableReason) state.non_actionable_reason = nonActionableReason;
  }

  session.remember(state, { treeShownToModel: options.treeShownToModel });
  return { state, screenshotBase64 };
}

/** 观察结果的 content 块装配:树文本 → 告知块 → 图 → image_ref。 */
export function buildObservationContent(treeText, advisories, screenshotBase64, imageRef) {
  const content = [{ type: "text", text: treeText }];
  for (const advisory of advisories) {
    if (advisory) content.push({ type: "text", text: advisory });
  }
  if (screenshotBase64) {
    content.push({ type: "image", data: screenshotBase64, mimeType: "image/png" });
  }
  if (imageRef) {
    content.push({ type: "text", text: imageRefBlockText(imageRef) });
  }
  return content;
}
