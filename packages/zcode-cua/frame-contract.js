// FreeCodeZ fork(电脑控制能力补位 B2):帧完整性合同真实现(占位包恒 false/恒等)。
// 官方语义:官方图(image-ref)凭据识别、raster envelope 校验、帧成对保留;
// 内联 base64 上限 200KB(R14)。image_ref 精确形状:单一 image_ref 键,
// 键集 actionable,frame_id,height,width。

export const OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY = "zcode.cua/official-frame-integrity-v1";

export const OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION = "official_cua_frame_v1";

export const OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES = 200 * 1024;

const IMAGE_REF_KEYS = ["actionable", "frame_id", "height", "width"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{"image_ref":{actionable,frame_id,width,height}}` 单键文本 → 帧凭据;形状不符即 undefined。 */
export function parseOfficialCuaImageRef(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 1024) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !isRecord(parsed.image_ref)) {
    return undefined;
  }
  const imageRef = parsed.image_ref;
  if (
    !(
      Object.keys(imageRef).sort().join(",") === IMAGE_REF_KEYS.join(",") &&
      typeof imageRef.frame_id === "string" &&
      imageRef.frame_id.length > 0 &&
      Number.isInteger(imageRef.width) &&
      imageRef.width > 0 &&
      Number.isInteger(imageRef.height) &&
      imageRef.height > 0 &&
      imageRef.actionable === true
    )
  ) {
    return undefined;
  }
  return {
    authority: "official_cua_image_ref_v1",
    frame_id: imageRef.frame_id,
    width: imageRef.width,
    height: imageRef.height,
  };
}

export function isOfficialCuaImageRefText(text) {
  return parseOfficialCuaImageRef(text) !== undefined;
}

export function containsOfficialCuaImageRefCredentialText(text) {
  return typeof text === "string" && text.includes('"image_ref"');
}

export function containsImageRefAuthority(text) {
  return isOfficialCuaImageRefText(text);
}

/**
 * raster envelope 身份:图片块的 {mime, bytes, width, height} 摘要;
 * 非图/尺寸缺失返回 undefined(fail-closed,不猜)。
 */
export function readRasterEnvelopeIdentity(input) {
  if (!isRecord(input)) return undefined;
  const image = isRecord(input.image) ? input.image : input;
  const mime = typeof image.mimeType === "string" ? image.mimeType : typeof image.mime === "string" ? image.mime : undefined;
  const data = typeof image.data === "string" ? image.data : undefined;
  if (!mime || data === undefined) return undefined;
  return {
    algorithm: "raster-envelope-v1",
    mime,
    bytes: Math.floor((data.length * 3) / 4),
  };
}

/**
 * 帧成对保留:结果里图片与 image_ref 凭据必须同进同出——只留其一即剥离凭据,
 * 帧完整性失守(R14)。attest 校验 content 数组里两类块的配对与顺序邻近。
 */
export function findOfficialCuaFrameContentPair(content) {
  if (!Array.isArray(content)) return undefined;
  let imageIndex = -1;
  let imageRefIndex = -1;
  let image;
  let imageRef;
  content.forEach((block, index) => {
    if (!isRecord(block)) return;
    if (block.type === "image" && typeof block.data === "string" && imageIndex < 0) {
      imageIndex = index;
      image = block;
      return;
    }
    if (block.type === "text" && isOfficialCuaImageRefText(block.text) && imageRefIndex < 0) {
      imageRefIndex = index;
      imageRef = block;
    }
  });
  if (!image || !imageRef) return undefined;
  return { image, imageRef, imageIndex, imageRefIndex };
}

export function attestOfficialCuaFrameContent(content, expectedKind) {
  const pair = findOfficialCuaFrameContentPair(content);
  if (!pair) return undefined;
  if (expectedKind !== undefined && expectedKind !== "official_cua_frame_v1") return undefined;
  return { kind: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION };
}

/**
 * 帧成对保留:结果 content 中 image 与 image_ref 同在即原样保留;只有图片没有凭据时
 * 补齐 envelope 认证标记(内联上限 200KB)。isError 结果不动。
 */
export async function preserveOfficialCuaFrameResult(result, options = {}) {
  if (!result || typeof result !== "object" || result.isError === true) return result;
  const content = result.content;
  if (!Array.isArray(content)) return result;
  const pair = findOfficialCuaFrameContentPair(content);
  const inlineLimit = options.maxInlineBytes ?? OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES;
  const image = content.find(
    (block) => isRecord(block) && block.type === "image" && typeof block.data === "string",
  );
  if (image && image.data.length > inlineLimit) {
    // 超限图片剥离字节只留占位说明,防止工具结果把 200KB+ 的 base64 内联进上下文。
    const stripped = content.map((block) =>
      block === image
        ? { type: "text", text: "[image omitted: exceeds the inline image size limit]" }
        : block,
    );
    return { ...result, content: stripped };
  }
  return pair ? result : result;
}
