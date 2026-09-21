// ============================================================
// ImageSearch Tool - 网络图片搜索(P6 去套餐能力补位)
// 三源降级链:SerpAPI(google_images) → Brave Images → Openverse(零 key 尾)
// 统一 envelope 见规格书 P6 §5;归一化层见 core handler。
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import type { ToolContractDeclaration } from "./contract.js";

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

export const ImageSearchInputSchema = z.object({
  query: z.string().min(1).describe("The image search query"),
  page: z.number().int().min(1).max(10).optional().describe("1-based page number"),
  pageSize: z.number().int().min(1).max(20).optional().describe("Results per page (default 10)"),
  license: z.enum(["any", "cc"]).optional().describe("Filter by license; 'cc' jumps to Openverse"),
});

export type ImageSearchInput = z.infer<typeof ImageSearchInputSchema>;

export const ImageSearchInputJsonSchema = toToolJsonSchema(ImageSearchInputSchema);

// -----------------------------------------------
// Output Envelope(规格书 P6 §5)
// -----------------------------------------------

export const ImageResultItemSchema = z
  .object({
    kind: z.literal("image"),
    title: z.string(),
    caption: z.string().nullable().optional(),
    originalUrl: z.string(),
    thumbnailUrl: z.string().nullable().optional(),
    pageUrl: z.string().nullable().optional(),
    width: z.number().int().nullable().optional(),
    height: z.number().int().nullable().optional(),
    source: z.string().nullable().optional(),
    provider: z.string(),
    license: z.string().nullable().optional(),
    attribution: z.string().nullable().optional(),
  })
  .strict();

export const ImageSearchMetaSchema = z
  .object({
    provider: z.string(),
    degradedFrom: z.string().nullable().optional(),
    cacheHit: z.boolean(),
    requestMs: z.number().nonnegative(),
    page: z.number().int(),
    pageSize: z.number().int(),
    hasMore: z.boolean(),
    truncated: z.boolean().optional(),
  })
  .strict();

export const ImageSearchOutputSchema = z
  .object({
    query: z.string(),
    summary: z.string().optional(),
    results: z.array(ImageResultItemSchema),
    meta: ImageSearchMetaSchema,
  })
  .strict();

export type ImageSearchOutput = z.infer<typeof ImageSearchOutputSchema>;
export type ImageResultItem = z.infer<typeof ImageResultItemSchema>;

export const ImageSearchOutputJsonSchema = toToolJsonSchema(ImageSearchOutputSchema);

export const IMAGE_SEARCH_TOOL_CONTRACT: ToolContractDeclaration = {
  capability: "image_search",
  executionMode: "client",
  inputSchema: ImageSearchInputJsonSchema,
  outputSchema: ImageSearchOutputJsonSchema,
  permission: {
    permission: "image_search",
    reason:
      "ImageSearch performs read-only image searches via configured providers (SerpAPI/Brave/Openverse)",
    riskLevel: "low",
    sideEffectScope: "network",
    needsApproval: false,
    patternSources: ["toolName", "input", "network"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 10_000,
    maxModelBytes: 24_000,
    strategy: "truncate",
    preview: {
      maxLines: 30,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30_000,
    maxMs: 60_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "Image search was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
