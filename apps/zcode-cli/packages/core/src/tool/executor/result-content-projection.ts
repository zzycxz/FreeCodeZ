import {
  type ModelMessageContent,
  type ModelMessageContentBlock,
} from "@zcode/contracts";
import type { ToolResultSerialization } from "../types.js";

interface HookStringProjection {
  content: string;
  truncated: boolean;
}

export function appendHookToStringContent(
  content: string,
  suffix: string,
  maxBytes: number,
  previewDirection: "head" | "tail",
): HookStringProjection {
  const augmentedContent = `${content}${suffix}`;
  if (Buffer.byteLength(augmentedContent, "utf8") <= maxBytes) {
    return { content: augmentedContent, truncated: false };
  }
  return {
    content: fitContentWithSuffix(content, maxBytes, suffix, previewDirection),
    truncated: true,
  };
}

export function appendHookToPersistedArtifactPreview(
  content: string,
  suffix: string,
  maxHookBytes: number,
): HookStringProjection {
  const fittedSuffix = fitStringToBytes(suffix, maxHookBytes, "head");
  return {
    content: `${content}${fittedSuffix}`,
    truncated: Buffer.byteLength(suffix, "utf8") > maxHookBytes,
  };
}

export function projectHookAugmentedModelContent(input: {
  artifactPreview: boolean;
  contentProjection: HookStringProjection;
  hookContext: string;
  maxModelBytes: number;
  modelContent: ModelMessageContent;
  previewDirection: "head" | "tail";
  suffix: string;
}): ModelMessageContent {
  if (input.artifactPreview) return input.contentProjection.content;
  if (!input.contentProjection.truncated) {
    return appendHookContextToModelContent(input.modelContent, input.hookContext);
  }
  if (!hasPreservedStructuredBlocks(input.modelContent)) return input.contentProjection.content;

  const textContent = budgetedTextFromStructuredContent(input.modelContent);
  const budgetedText = fitContentWithSuffix(
    textContent,
    input.maxModelBytes,
    input.suffix,
    input.previewDirection,
  );
  return [
    ...input.modelContent.filter(shouldPreserveStructuredBlock),
    ...(budgetedText.length > 0 ? [{ type: "text" as const, text: budgetedText }] : []),
  ];
}

export function fitContentWithSuffix(
  content: string,
  maxBytes: number,
  suffix: string,
  direction: "head" | "tail",
): string {
  if (maxBytes <= 0) return "";
  const suffixContent = fitStringToBytes(suffix, maxBytes, "head");
  const remainingBytes = maxBytes - Buffer.byteLength(suffixContent, "utf8");
  if (remainingBytes <= 0) return suffixContent;
  return `${fitStringToBytes(content, remainingBytes, direction)}${suffixContent}`;
}

function appendHookContextToModelContent(
  content: ModelMessageContent,
  hookContext: string,
): ModelMessageContent {
  if (typeof content === "string") return `${content}\n\n${hookContext}`;
  return [...content, { type: "text", text: hookContext }];
}

function hasPreservedStructuredBlocks(
  content: ModelMessageContent,
): content is ModelMessageContentBlock[] {
  return Array.isArray(content) && content.some(shouldPreserveStructuredBlock);
}

function shouldPreserveStructuredBlock(block: ModelMessageContentBlock): boolean {
  if (block.type === "text") return false;
  if (block.type === "file" && typeof block.text === "string" && block.text.length > 0) {
    return false;
  }
  return true;
}

function budgetedTextFromStructuredContent(content: ModelMessageContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "file" && typeof block.text === "string") return block.text;
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function fitStringToBytes(value: string, maxBytes: number, direction: "head" | "tail"): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  const chars = Array.from(value);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate =
      direction === "tail"
        ? chars.slice(chars.length - mid).join("")
        : chars.slice(0, mid).join("");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return direction === "tail"
    ? chars.slice(chars.length - low).join("")
    : chars.slice(0, low).join("");
}
