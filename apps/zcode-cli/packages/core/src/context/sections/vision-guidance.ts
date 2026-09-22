import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

/**
 * FreeCodeZ fork(P6 §4.5,docs/spec/search-vision-settings.md):文本模型会话的
 * 图片引用引导。套餐时代的引导全部内嵌在托管 MCP 工具描述里;fork 拆套餐后
 * 文本模型的图片走 `<image path>` 引用 + ImageUnderstand,弱模型不会自发联想到
 * 这条路径,需要一段系统级引导。
 *
 * 注入条件只依赖模型能力(与 adapters 的 inputFormat 校验同源),同会话内内容
 * 逐字节稳定——cacheHint 取 stable,不打断前缀缓存;模型切换时上下文本就重建。
 */
export function buildVisionGuidanceSection(
  model: { properties: { inputFormat: { supportsImage: boolean } } } | undefined,
): ContextSection | null {
  if (!model || model.properties.inputFormat.supportsImage) return null;
  const content = [
    "# Vision Input Guidance",
    "",
    "- The current model cannot see images directly. Images in this conversation appear as text",
    "  references like `[Image: source: <path>]`, or are omitted from your context entirely.",
    "- To analyze what an image shows, call the ImageUnderstand tool with the image path and a",
    "  specific prompt (layout, text content, error messages, tables). You may call it multiple",
    "  times with different prompts to examine different aspects.",
  ].join("\n");
  return {
    name: "Vision Input Guidance",
    source: "vision_guidance",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
