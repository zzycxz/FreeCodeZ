// B1：全仓唯一的 token 估算口径（此前三处实现互相矛盾：context/utils 为 CJK×2÷3、
// compact/manual 与 compact-post-reminders 为无 CJK 加权 ÷3、MCP 观测为 CJK×2÷4）。
// 统一规则：中文字符按 3 个估算字符计、其余按 1 计，总和 ÷4。
// 依据：纯 ÷3 对英文高估约 33%——auto compact 阈值被提前触发，白丢约 20% 窗口；
// 而纯 ÷4 丢 CJK 加权会把中文从 0.667 降到 0.5 token/字（溢出风险方向）。
// 取 CJK×3÷4=0.75/字：英文降至 0.25/字符（修正高估），中文不低于旧口径（防溢出回归）。
// provider usage anchor（compact 的 tokenOverride 管道）优先于任何估算，本函数只兜
// 无 anchor 窗口：首轮、compact 后（旧前缀 usage 清零）与 provider 未回 usage 的场景。
export const ESTIMATED_TOKEN_CHAR_DIVISOR = 4;
export const CJK_CHAR_ESTIMATE_WEIGHT = 3;

const CJK_CHAR_RE = /[一-鿿]/g;

/** 按统一口径估算文本 token 数（粗估，供压缩阈值/预算/观测用，不用于计费）。 */
export function estimateTokensFromText(text: string): number {
  const chineseChars = (text.match(CJK_CHAR_RE) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil((chineseChars * CJK_CHAR_ESTIMATE_WEIGHT + otherChars) / ESTIMATED_TOKEN_CHAR_DIVISOR);
}
