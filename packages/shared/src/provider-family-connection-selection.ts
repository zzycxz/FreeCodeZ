import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

export const providerFamilyConnectionSelectionSchema = z.discriminatedUnion("kind", [
  // tombstone（model-provider-intake C5）：Start Plan 已随 bigmodel+zai 账号族下线，
  // 但 `"start-plan"` 是已持久化 setting.json 的判别字面量，绝不能从联合中删除——
  // 否则整份 appSettings safeParse 失败并静默回退全默认值。消费方一律视为「无连接」。
  z.object({ kind: z.literal("start-plan") }).strict(),
  z.object({ kind: z.literal("individual-coding-plan") }).strict(),
  z
    .object({
      kind: z.literal("team-coding-plan"),
      productId: nonEmptyString,
      organizationId: nonEmptyString,
      projectId: nonEmptyString,
    })
    .strict(),
]);

export const providerFamilyConnectionSelectionSettingsSchema = z
  .object({
    zai: providerFamilyConnectionSelectionSchema.optional(),
    bigmodel: providerFamilyConnectionSelectionSchema.optional(),
  })
  .partial();

/** 用户对一个 Provider Family 的连接选择意图；不包含账号身份或动态凭据。 */
export type ProviderFamilyConnectionSelection = Readonly<
  z.infer<typeof providerFamilyConnectionSelectionSchema>
>;

export type ProviderFamilyConnectionSelectionSettings = z.infer<
  typeof providerFamilyConnectionSelectionSettingsSchema
>;
