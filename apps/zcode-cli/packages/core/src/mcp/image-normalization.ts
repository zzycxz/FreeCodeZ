import { isAbsolute, resolve } from "node:path";
import {
  ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY,
  type McpContentBlock,
  type McpToolCallResult,
  type McpToolDescriptor,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolExecutionContext } from "../tool/types.js";

// 通用 MCP 图片 inline 预算独立定义，不依赖外部契约常量。
export const MCP_IMAGE_INLINE_BASE64_BYTES = 200 * 1024;
export const MCP_IMAGE_INLINE_RAW_BYTES = Math.floor((MCP_IMAGE_INLINE_BASE64_BYTES * 3) / 4);
export const HOST_NODE_REPL_IMAGE_MAX_DIMENSION = 2048;
// Provider 的模型图片上限是 2000px；Browser 轮尾展示仍沿用独立的 2048px 预算。
const HOST_NODE_REPL_MODEL_IMAGE_MAX_DIMENSION = 2000;

export async function normalizeMcpToolResultForModel(input: {
  compressOversizedImages: boolean;
  context: ToolExecutionContext;
  descriptor: McpToolDescriptor;
  result: McpToolCallResult;
  toolName: string;
}): Promise<McpToolCallResult> {
  let changed = false;
  const content: McpContentBlock[] = [];
  const browserScreenshotIndices = input.compressOversizedImages
    ? readBrowserScreenshotContentIndices(input.result)
    : new Set<number>();

  for (const [index, block] of input.result.content.entries()) {
    const browserScreenshotArtifact = browserScreenshotIndices.has(index)
      ? await persistBrowserScreenshotArtifact(block, input)
      : undefined;
    const normalized = await normalizeMcpContentBlockForModel(block, {
      ...input,
      browserScreenshotArtifact,
    });
    changed ||= normalized !== block;
    content.push(normalized);
    // 提示文本插在 image 之前会把 node_repl 特意排成 image-first 的
    // tool_result.content 重新变成 text-first；Anthropic 兼容网关只解析开头的连续 image，
    // text 一领先后面的图就被丢弃，模型又看不到截图。落在 image 之后即可保持 image-first。
    if (browserScreenshotArtifact) {
      content.push({
        type: "text",
        text: `Browser screenshot saved to: ${browserScreenshotArtifact.absolutePath}`,
      });
      changed = true;
    }
  }

  return changed ? { ...input.result, content } : input.result;
}

async function normalizeMcpContentBlockForModel(
  block: McpContentBlock,
  input: {
    compressOversizedImages: boolean;
    context: ToolExecutionContext;
    descriptor: McpToolDescriptor;
    toolName: string;
    browserScreenshotArtifact?: BrowserScreenshotArtifact;
  },
): Promise<McpContentBlock> {
  if (block.type !== "image") return block;

  const data = typeof block.data === "string" ? block.data : undefined;
  const mimeType = typeof block.mimeType === "string" ? block.mimeType : undefined;
  if (!data || !mimeType) return block;

  const base64Payload = base64PayloadFromMcpImageData(data);
  const base64Bytes = Buffer.byteLength(base64Payload, "utf8");
  if (base64Bytes <= MCP_IMAGE_INLINE_BASE64_BYTES) return block;

  if (input.compressOversizedImages) {
    // browser screenshot 由可信宿主 node_repl 产生，不能和第三方 MCP 图片一样直接
    // 落 artifact，导致模型失去视觉结果；这里复用统一图片端口压到 200 KiB，而不另造编解码器。
    const compressed = await tryCompressHostNodeReplImage({
      base64Payload,
      context: input.context,
      mimeType,
    });
    if (compressed) return compressed;
  }

  const summary = {
    base64Bytes,
    inlineLimitBytes: MCP_IMAGE_INLINE_BASE64_BYTES,
    mimeType,
  };

  if (input.browserScreenshotArtifact) {
    return {
      type: "text",
      text: [
        `MCP image content omitted: ${mimeType}, base64=${formatByteSize(base64Bytes)} exceeds inline limit ${formatByteSize(MCP_IMAGE_INLINE_BASE64_BYTES)}.`,
        "The original browser screenshot remains available at the adjacent absolute path.",
      ].join("\n"),
    };
  }

  if (!input.context.artifactStore) {
    return {
      type: "text",
      text: [
        `MCP image content omitted: ${mimeType}, base64=${formatByteSize(base64Bytes)} exceeds inline limit ${formatByteSize(MCP_IMAGE_INLINE_BASE64_BYTES)}.`,
        "No artifact store is configured, so the original image could not be saved.",
      ].join("\n"),
    };
  }

  const artifact = await writeMcpImageArtifact({
    base64Payload,
    context: input.context,
    dataUrl: asDataUrl(data, mimeType),
    descriptor: input.descriptor,
    summary,
    toolName: input.toolName,
  });

  return {
    type: "text",
    text: [
      `MCP image content saved instead of being inlined: ${mimeType}, base64=${formatByteSize(base64Bytes)}, inlineLimit=${formatByteSize(MCP_IMAGE_INLINE_BASE64_BYTES)}.`,
      `Artifact: ${artifact.path ?? artifact.uri}`,
      `Artifact URI: ${artifact.uri}`,
    ].join("\n"),
  };
}

interface BrowserScreenshotArtifact {
  absolutePath: string;
}

function readBrowserScreenshotContentIndices(result: McpToolCallResult): Set<number> {
  const value = result._meta?.[ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY];
  if (!Array.isArray(value)) return new Set<number>();
  return new Set(
    value.filter(
      (index): index is number =>
        Number.isInteger(index) && index >= 0 && index < result.content.length,
    ),
  );
}

async function persistBrowserScreenshotArtifact(
  block: McpContentBlock,
  input: {
    context: ToolExecutionContext;
    toolName: string;
  },
): Promise<BrowserScreenshotArtifact | undefined> {
  if (block.type !== "image") return undefined;
  const data = typeof block.data === "string" ? block.data : undefined;
  const mimeType = typeof block.mimeType === "string" ? block.mimeType : undefined;
  const artifactStore = input.context.artifactStore;
  const writeBinary = artifactStore?.writeToolResultBinaryArtifact;
  if (!data || !mimeType || !artifactStore || !writeBinary) return undefined;

  const content = Buffer.from(base64PayloadFromMcpImageData(data), "base64");
  if (content.byteLength === 0) return undefined;
  try {
    const artifact = await writeBinary.call(
      artifactStore,
      {
        sessionId: input.context.sessionId,
        turnId: input.context.turnId,
        toolCallId: input.context.toolCallId,
        toolName: input.toolName,
        content,
        contentType: mimeType,
        extension: extensionForMimeType(mimeType),
        retention: "session",
        trace: traceFromToolContext(input.context),
      },
      { signal: input.context.abortSignal },
    );
    if (!artifact.path) return undefined;
    return {
      absolutePath: isAbsolute(artifact.path) ? artifact.path : resolve(artifact.path),
    };
  } catch (error) {
    // 额外截图路径写入失败不应覆盖已成功的 Browser 结果；
    // 但工具取消时仍需立即退出，不继续处理大图。
    if (input.context.abortSignal.aborted) throw error;
    return undefined;
  }
}

async function tryCompressHostNodeReplImage(input: {
  base64Payload: string;
  context: ToolExecutionContext;
  mimeType: string;
}): Promise<McpContentBlock | undefined> {
  const imageProcessorPort = input.context.imageProcessorPort;
  if (!imageProcessorPort) return undefined;

  const decoded = Buffer.from(input.base64Payload, "base64");
  if (decoded.byteLength === 0) return undefined;

  try {
    const prepared = await imageProcessorPort.prepareForModel(
      {
        data: decoded,
        maxBase64Bytes: MCP_IMAGE_INLINE_BASE64_BYTES,
        maxDimension: HOST_NODE_REPL_MODEL_IMAGE_MAX_DIMENSION,
        maxRawBytes: MCP_IMAGE_INLINE_RAW_BYTES,
        mediaType: input.mimeType,
        trace: traceFromToolContext(input.context),
      },
      { signal: input.context.abortSignal },
    );
    const compressedBase64 = Buffer.from(prepared.data).toString("base64");
    const compressedBase64Bytes = Buffer.byteLength(compressedBase64, "utf8");
    if (
      compressedBase64Bytes === 0 ||
      compressedBase64Bytes > MCP_IMAGE_INLINE_BASE64_BYTES ||
      !prepared.mediaType.startsWith("image/")
    ) {
      return undefined;
    }
    return {
      type: "image",
      data: compressedBase64,
      mimeType: prepared.mediaType,
    };
  } catch (error) {
    if (input.context.abortSignal.aborted) throw error;
    return undefined;
  }
}

async function writeMcpImageArtifact(input: {
  base64Payload: string;
  context: ToolExecutionContext;
  dataUrl: string;
  descriptor: McpToolDescriptor;
  summary: {
    base64Bytes: number;
    inlineLimitBytes: number;
    mimeType: string;
  };
  toolName: string;
}): Promise<{
  bytes: number;
  contentType: string;
  path?: string;
  uri: string;
}> {
  const artifactStore = input.context.artifactStore;
  if (!artifactStore) {
    throw new Error("MCP image artifact store is not configured");
  }

  if (artifactStore.writeToolResultBinaryArtifact) {
    return artifactStore.writeToolResultBinaryArtifact(
      {
        sessionId: input.context.sessionId,
        turnId: input.context.turnId,
        toolCallId: input.context.toolCallId,
        toolName: input.toolName,
        content: Buffer.from(input.base64Payload, "base64"),
        contentType: input.summary.mimeType,
        extension: extensionForMimeType(input.summary.mimeType),
        retention: "session",
        trace: traceFromToolContext(input.context),
      },
      { signal: input.context.abortSignal },
    );
  }

  return artifactStore.writeToolResultArtifact(
    {
      sessionId: input.context.sessionId,
      turnId: input.context.turnId,
      toolCallId: input.context.toolCallId,
      toolName: input.toolName,
      content: JSON.stringify(
        {
          type: "mcp-image-artifact",
          createdAt: new Date().toISOString(),
          dataUrl: input.dataUrl,
          registeredToolName: input.toolName,
          serverName: input.descriptor.serverName,
          toolName: input.descriptor.toolName,
          ...input.summary,
        },
        null,
        2,
      ),
      contentType: "application/json",
      retention: "session",
      trace: traceFromToolContext(input.context),
    },
    { signal: input.context.abortSignal },
  );
}

export function asDataUrl(data: string, mimeType: string): string {
  return data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
}

export function base64PayloadFromMcpImageData(data: string): string {
  if (!data.startsWith("data:")) return data;
  const commaIndex = data.indexOf(",");
  return commaIndex >= 0 ? data.slice(commaIndex + 1) : data;
}

function extensionForMimeType(mimeType: string): string {
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (mime) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".bin";
  }
}

function traceFromToolContext(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as TraceContext;
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted =
    value >= 10 || unitIndex === 0 ? Math.round(value).toString() : value.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}
