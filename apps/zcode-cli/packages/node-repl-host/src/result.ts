import { ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY } from "@zcode/contracts/mcp";
import type { NodeReplRunResult } from "@zcode/core/repl";
import type { CallToolResult } from "@modelcontextprotocol/server";

type EmbeddedContentBlock = CallToolResult["content"][number];

interface EmbeddedMcpResult {
  content: EmbeddedContentBlock[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

function parseEmbeddedMcpResult(value: string): EmbeddedMcpResult | undefined {
  const trimmed = value.trim();
  const json = trimmed.startsWith("=>") ? trimmed.slice(2).trim() : trimmed;
  if (!json.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const candidate = parsed as Record<string, unknown>;
    if (!Array.isArray(candidate.content)) return undefined;
    if (
      candidate.content.some(
        (block) => !block || typeof block !== "object" || typeof (block as { type?: unknown }).type !== "string",
      )
    ) {
      return undefined;
    }
    return {
      content: candidate.content as EmbeddedContentBlock[],
      ...(typeof candidate.isError === "boolean" ? { isError: candidate.isError } : {}),
      ...(candidate.structuredContent && typeof candidate.structuredContent === "object"
        ? { structuredContent: candidate.structuredContent as Record<string, unknown> }
        : {}),
      ...(candidate._meta && typeof candidate._meta === "object"
        ? { _meta: candidate._meta as Record<string, unknown> }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export function toMcpRunResult(run: NodeReplRunResult): CallToolResult {
  const textParts: string[] = [];
  // SDK 结果通过专用 sink 写入后，不能再从 run.result/console 日志解析第二份副本。
  // 否则模型的 JSON.stringify 会把 image base64 降成普通文本，破坏 image/image_ref 邻接关系。
  const structuredResults = run.structuredResults ?? [];
  const embedded =
    structuredResults.length === 0 && !run.error && run.result !== undefined
      ? parseEmbeddedMcpResult(run.result)
      : undefined;
  const responseMeta = { ...run.responseMeta };
  for (const structured of structuredResults) {
    if (structured._meta) Object.assign(responseMeta, structured._meta);
  }
  if (embedded?._meta) Object.assign(responseMeta, embedded._meta);
  // 该 key 决定 core 是否把原图落盘，不能允许 REPL 代码通过
  // setResponseMeta 伪造来源；只接受 NodeReplSession 根据真实 screenshot payload 生成的索引。
  delete responseMeta[ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY];
  // Anthropic 兼容网关（如 bigmodel MaaS）只解析 tool_result.content 开头的连续
  // image block，一旦先遇到 text 就丢弃后面的图，模型只能看到 image_ref 元数据而看不到画面
  // （实测 [image]/[image,text] 可见，[text,image]/[text,image,text] 不可见）。
  // 把 image 排在 text 之前即可让图稳定到达模型；顺序在 Anthropic 规范里本就是自由的。
  // image 因此从 content[0] 起连续排列，image 下标与 content 下标相等，无需再做 +1 偏移。
  const browserScreenshotContentIndices = run.browserScreenshotImageIndices;
  const structuredContent = structuredResults.flatMap(
    (structured) => structured.content as EmbeddedContentBlock[],
  );
  const structuredContentResult = [...structuredResults]
    .reverse()
    .find((structured) => structured.structuredContent !== undefined);
  const structuredIsError = structuredResults.some((structured) => structured.isError === true);
  if (run.error) {
    // node_repl 若用 message-only 隐藏通用 MCP 失败前缀，只消费
    // 模型结果文本的分析链路无法区分成功与失败。继续只返回结构化 error.message，
    // 不混入错误类型、堆栈或失败前日志，并让通用 bridge 根据 isError 投影稳定标记。
    textParts.push(run.error.message);
  } else {
    if (run.logs) textParts.push(run.logs);
    if (structuredResults.length === 0 && run.result !== undefined && !embedded) {
      textParts.push(`=> ${run.result}`);
    }
  }

  const content = [
    ...(run.error
      ? []
      : structuredResults.length > 0
        ? structuredContent
        : (run.images ?? []).map((image) => ({
            type: "image" as const,
            data: image.base64,
            mimeType: image.mimeType,
          }))),
    ...(structuredResults.length > 0
      ? // 结构化观察已携带截图；模型再次 emitImage 同一张图时，只保留结构化结果中的副本。
        // 去重必须逐字节相等：保留截图原始像素及其 frame_id 绑定，不同图片仍交由帧校验拒绝。
        (run.images ?? [])
          .filter(
            (image) =>
              !structuredContent.some(
                (block) =>
                  block.type === "image" &&
                  (block as { data?: string }).data === image.base64,
              ),
          )
          .map((image) => ({
            type: "image" as const,
            data: image.base64,
            mimeType: image.mimeType,
          }))
      : []),
    ...(embedded?.content ?? []),
    ...(textParts.length > 0 ? [{ type: "text" as const, text: textParts.join("\n") }] : []),
  ];

  return {
    content: content.length > 0 ? content : [{ type: "text" as const, text: "(no output)" }],
    ...(run.error || embedded?.isError || structuredIsError ? { isError: true } : {}),
    ...(structuredContentResult?.structuredContent !== undefined
      ? { structuredContent: structuredContentResult.structuredContent }
      : embedded?.structuredContent !== undefined
        ? { structuredContent: embedded.structuredContent }
        : {}),
    ...(Object.keys(responseMeta).length > 0 ||
    (run.images?.length ?? 0) > 0 ||
    structuredContent.some((block) => block.type === "image")
      ? {
          _meta: {
            ...responseMeta,
            ...((run.images?.length ?? 0) > 0 || structuredContent.some((block) => block.type === "image")
              ? { "zcode/nodeReplEmittedImage": true }
              : {}),
            ...(browserScreenshotContentIndices && browserScreenshotContentIndices.length > 0
              ? {
                  [ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY]:
                    browserScreenshotContentIndices,
                }
              : {}),
          },
        }
      : {}),
  };
}
