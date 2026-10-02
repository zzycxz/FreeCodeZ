// ============================================================
// Token Estimation
// ============================================================
// B1：估算实现迁移至 @zcode/shared 的 token-estimate（全仓唯一口径：CJK 按 3 个
// 估算字符计、总和 ÷4）。本文件保留同名导出，避免几十处 `estimateTokens` 引用
// 逐个改 import；行为变化见 token-estimate.ts 头注（英文下调 25%、中文不低于旧口径）。
export { estimateTokensFromText as estimateTokens } from "@zcode/shared";
