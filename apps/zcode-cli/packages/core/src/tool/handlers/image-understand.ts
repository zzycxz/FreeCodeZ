// ============================================================
// ImageUnderstand / ViewImage Tools(P6 §3.1 条件内联已拍板)
// image_understand:任意模型轨——读本地图片→(必要时缩放)→发给
// 支持视觉的模型。选取顺序(P6 §6.2 接线,docs/spec/search-vision-settings.md §4.1):
// 绑定 VLM(searchVision.visionModelSelection,可解析且 supportsImage)
// → 当前会话模型 → 都不行则可恢复配置引导错误(fairpeer「视觉模型」语义)。
// view_image:仅加载图片元数据;内容分析一律走 image_understand。
// ============================================================

import { readFile, stat } from "node:fs/promises";
import {
  CoreErrorType,
  IMAGE_UNDERSTAND_TOOL_CONTRACT,
  VIEW_IMAGE_TOOL_CONTRACT,
  ImageUnderstandInputJsonSchema,
  ImageUnderstandInputSchema,
  ImageUnderstandOutputJsonSchema,
  ImageUnderstandOutputSchema,
  ViewImageInputJsonSchema,
  ViewImageInputSchema,
  ViewImageOutputJsonSchema,
  ViewImageOutputSchema,
  createCoreError,
  type ImageUnderstandInput,
  type ImageUnderstandOutput,
  type ViewImageInput,
  type ViewImageOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { auxiliaryModelOptions } from "../../model/auxiliary-model-options.js";

const IMAGE_UNDERSTAND_TOOL_NAME = "ImageUnderstand";
const VIEW_IMAGE_TOOL_NAME = "ViewImage";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

interface LoadedImage {
  path: string;
  bytes: Uint8Array;
  mime: string;
  base64: string;
}

async function loadImage(path: string): Promise<LoadedImage> {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) {
    throw createCoreError(CoreErrorType.InvalidInput, `Not a file: ${path}`, {
      context: { toolName: IMAGE_UNDERSTAND_TOOL_NAME },
      recoverable: false,
    });
  }
  if (fileStat.size > MAX_IMAGE_BYTES) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      `Image exceeds 5MB limit (${fileStat.size} bytes): ${path}`,
      { context: { toolName: IMAGE_UNDERSTAND_TOOL_NAME }, recoverable: false },
    );
  }
  const bytes = new Uint8Array(await readFile(path));
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  const mime = MIME_BY_EXTENSION[extension];
  if (!mime) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      `Unsupported image extension "${extension}" (png/jpg/jpeg/gif/webp/bmp): ${path}`,
      { context: { toolName: IMAGE_UNDERSTAND_TOOL_NAME }, recoverable: false },
    );
  }
  return { path, bytes, mime, base64: Buffer.from(bytes).toString("base64") };
}

function imageDimensions(bytes: Uint8Array, mime: string): { width: number | null; height: number | null } {
  try {
    if (mime === "image/png" && bytes.length >= 24) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if ((mime === "image/jpeg" || mime === "image/jpg") && bytes.length >= 4) {
      return decodeJpegDimensions(bytes);
    }
    if (mime === "image/gif" && bytes.length >= 10) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    if (mime === "image/bmp" && bytes.length >= 26) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { width: view.getInt32(18, true), height: view.getInt32(22, true) };
    }
  } catch {
    // 尺寸探测失败返回 null(规格书 P6 §4.3:dimensions 可 null)。
  }
  return { width: null, height: null };
}

function decodeJpegDimensions(bytes: Uint8Array): { width: number | null; height: number | null } {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const segmentLength = view.getUint16(offset + 2);
    offset += 2 + segmentLength;
  }
  return { width: null, height: null };
}

// -----------------------------------------------
// ImageUnderstand handler
// -----------------------------------------------

const imageUnderstandHandler: ToolHandler<ImageUnderstandInput, ImageUnderstandOutput> = async (
  input,
  context,
) => {
  const image = await loadImage(input.path);
  const dimensions = imageDimensions(image.bytes, image.mime);

  // FreeCodeZ fork(P6 §3.1 接线):绑定 VLM 优先,回退当前会话模型。
  // resolveSearchVisionModel 解析失败(ref 失效/provider 已删)返回 undefined,
  // 与未绑定同路——由下面的配置引导错误统一收口,不静默降级到不可用模型。
  const boundVisionModel = context.resolveSearchVisionModel?.();
  const visionModel =
    boundVisionModel?.properties.inputFormat.supportsImage === true
      ? boundVisionModel
      : context.model;
  if (!visionModel) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "image_understand requires a model binding; no model is available in this context",
      { context: { toolName: IMAGE_UNDERSTAND_TOOL_NAME }, recoverable: false },
    );
  }
  if (!visionModel.properties.inputFormat.supportsImage) {
    // 场景 13(P6 §8):未配置视觉模型 → 配置引导错误,不静默失败。
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "image_understand requires a vision-capable model, and neither the configured "
        + "vision model binding nor the current session model accepts images. Fix it "
        + "either way: bind a vision model in Settings → Search & Vision (works even "
        + "while the session model stays text-only), or switch the session to a "
        + "multimodal model.",
      { context: { toolName: IMAGE_UNDERSTAND_TOOL_NAME, path: input.path }, recoverable: true },
    );
  }

  // 经现有 Model bind 直发(与消息流内联同一条链;不新起执行器)。
  const request: Parameters<typeof visionModel.streamText>[0] = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: input.prompt },
          {
            type: "image",
            mediaType: image.mime,
            dataUrl: `data:${image.mime};base64,${image.base64}`,
          },
        ],
      },
    ],
    options: auxiliaryModelOptions(visionModel),
    abortSignal: context.abortSignal,
  };
  const result = await visionModel.streamText(request);
  let description = "";
  for await (const event of result) {
    if (event.type === "text_delta") description += event.text;
    if (event.type === "error") throw event.error;
  }

  const factHeader =
    `[image: ${input.path.split(/[\\/]/).pop() ?? input.path}`
    + (dimensions.width && dimensions.height ? ` | ${dimensions.width}x${dimensions.height}` : "")
    + ` | ${image.mime} | vision: ${visionModel.modelId}]`;

  return {
    path: input.path,
    width: dimensions.width,
    height: dimensions.height,
    mime: image.mime,
    bytes: image.bytes.byteLength,
    visionModel: visionModel.modelId,
    prompt: input.prompt,
    description: description.trim(),
    factHeader,
  };
};

export const imageUnderstandToolEntry: ToolEntry = {
  ...IMAGE_UNDERSTAND_TOOL_CONTRACT,
  metadata: {
    name: IMAGE_UNDERSTAND_TOOL_NAME,
    description:
      "Analyze a local image with a vision model. Ask any question about the image content "
        + "(layout, text, errors, tables-to-markdown, UI screenshots). Works with any "
        + "vision-capable model configured in the provider registry.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 120_000,
    maxOutputBytes: 20_000,
    sideEffectScope: "network",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: imageUnderstandHandler as ToolHandler,
  inputSchema: ImageUnderstandInputJsonSchema,
  outputSchema: ImageUnderstandOutputJsonSchema,
  runtimeInputSchema: ImageUnderstandInputSchema,
  runtimeOutputSchema: ImageUnderstandOutputSchema,
};

// -----------------------------------------------
// ViewImage handler
// -----------------------------------------------

const viewImageHandler: ToolHandler<ViewImageInput, ViewImageOutput> = async (input, context) => {
  const image = await loadImage(input.path);
  const dimensions = imageDimensions(image.bytes, image.mime);
  // FreeCodeZ fork 诚实化:本工具只加载元数据,不把图片字节注入上下文
  // (P6 规格里"marker 由 agent 循环转 image 内容块"的路径未实现、暂缓——
  // 多模态模型本就内联直读,文本模型应改用 ImageUnderstand)。
  // inlineable 如实反映当前会话模型的图片能力,不再恒为 true。
  const modelSupportsImage = context.model?.properties.inputFormat.supportsImage === true;
  return {
    path: input.path,
    width: dimensions.width,
    height: dimensions.height,
    mime: image.mime,
    bytes: image.bytes.byteLength,
    inlineable: modelSupportsImage,
    note:
      `Image metadata loaded (${image.bytes.byteLength} bytes, ${image.mime}`
      + (dimensions.width && dimensions.height ? `, ${dimensions.width}x${dimensions.height}` : "")
      + "). This tool does NOT attach the image content. To analyze what the image "
      + "shows, call ImageUnderstand with this path and a specific prompt.",
  };
};

export const viewImageToolEntry: ToolEntry = {
  ...VIEW_IMAGE_TOOL_CONTRACT,
  metadata: {
    name: VIEW_IMAGE_TOOL_NAME,
    description:
      "Load a local image file's metadata (path, dimensions, size, mime). Does NOT attach the "
      + "image content to the conversation — call ImageUnderstand with the path to analyze what "
      + "an image shows. Multimodal session models already see pasted/Read images inline and do "
      + "not need this tool.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 10_000,
    maxOutputBytes: 4_000,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: viewImageHandler as ToolHandler,
  inputSchema: ViewImageInputJsonSchema,
  outputSchema: ViewImageOutputJsonSchema,
  runtimeInputSchema: ViewImageInputSchema,
  runtimeOutputSchema: ViewImageOutputSchema,
};
