// ============================================================
// ImageUnderstand / ViewImage Tools(P6 去套餐能力补位)
// image_understand: 任意模型轨——读文件→缩放→经 Model bind 发给视觉模型。
// view_image: 多模态主模型直读轨的显式动作化。
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import type { ToolContractDeclaration } from "./contract.js";

export const ImageUnderstandInputSchema = z.object({
  path: z.string().min(1).describe("Absolute path to a local image file"),
  prompt: z
    .string()
    .min(1)
    .describe("What to analyze in the image; the question to answer about it"),
});

export type ImageUnderstandInput = z.infer<typeof ImageUnderstandInputSchema>;
export const ImageUnderstandInputJsonSchema = toToolJsonSchema(ImageUnderstandInputSchema);

export const ImageUnderstandOutputSchema = z
  .object({
    path: z.string(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    mime: z.string(),
    bytes: z.number().int().nonnegative(),
    visionModel: z.string().nullable(),
    prompt: z.string(),
    description: z.string(),
    factHeader: z.string(),
  })
  .strict();

export type ImageUnderstandOutput = z.infer<typeof ImageUnderstandOutputSchema>;
export const ImageUnderstandOutputJsonSchema = toToolJsonSchema(ImageUnderstandOutputSchema);

export const IMAGE_UNDERSTAND_TOOL_CONTRACT: ToolContractDeclaration = {
  capability: "image_understand",
  executionMode: "client",
  inputSchema: ImageUnderstandInputJsonSchema,
  outputSchema: ImageUnderstandOutputJsonSchema,
  permission: {
    permission: "read_file",
    reason: "ImageUnderstand reads a local image file and sends it to the configured vision model",
    riskLevel: "low",
    sideEffectScope: "network",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 20_000,
    maxModelBytes: 20_000,
    strategy: "truncate",
  },
  timeout: {
    defaultMs: 120_000,
    maxMs: 180_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "Image analysis was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

// -----------------------------------------------
// ViewImage
// -----------------------------------------------

export const ViewImageInputSchema = z.object({
  path: z.string().min(1).describe("Absolute path to a local image file (max 3MB)"),
});

export type ViewImageInput = z.infer<typeof ViewImageInputSchema>;
export const ViewImageInputJsonSchema = toToolJsonSchema(ViewImageInputSchema);

export const ViewImageOutputSchema = z
  .object({
    path: z.string(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    mime: z.string(),
    bytes: z.number().int().nonnegative(),
    inlineable: z.boolean(),
    note: z.string(),
  })
  .strict();

export type ViewImageOutput = z.infer<typeof ViewImageOutputSchema>;
export const ViewImageOutputJsonSchema = toToolJsonSchema(ViewImageOutputSchema);

export const VIEW_IMAGE_TOOL_CONTRACT: ToolContractDeclaration = {
  capability: "view_image",
  executionMode: "client",
  inputSchema: ViewImageInputJsonSchema,
  outputSchema: ViewImageOutputJsonSchema,
  permission: {
    permission: "read_file",
    reason: "ViewImage reads a local image file and surfaces it to the conversation",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 4_000,
    maxModelBytes: 4_000,
    strategy: "truncate",
  },
  timeout: {
    defaultMs: 10_000,
    maxMs: 20_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "View image was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
