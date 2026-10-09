/**
 * CUA 工具名判定（渲染分类开关）。
 *
 * 从 lib/cuaPermissionAction.ts 迁出（2026-10-09，规格书 M.2「先迁 isZCodeCuaToolName
 * 再删权限件」）：权限恢复链随 CUA 栈拆除，但本判定是 ToolCallBlock 渲染分类的开关
 * （cua.tsx 消费），W-30 换新命名空间前必须继续存活。
 */
function normalizeToolName(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/_/g, "-") ?? "";
}

export function isZCodeCuaToolName(value: string | null | undefined): boolean {
  const normalized = normalizeToolName(value);
  // server key 段为 computer-use。feat: mcp__computer-use__*；
  // main v3.5.3 的 plugin MCP 命名约定给 plugin server 加 namespace：
  // mcp__plugin_zcode-cua_computer-use__*（归一化后 server 段前是单连字符 cua-computer-use，
  // 不是双连字符）。两种形态都包含 "computer-use" 串——用 includes 兼容，否则 main 的 namespace
  // 前缀会让 cua 工具识别失败、ToolCallBlock 退化成 fallback 渲染。"computer-use" 足够特异
  // （仅 cua server 用此 key，不会误判 android-emulator/browser-use 等）。
  return normalized === "computer-use" || normalized.includes("computer-use");
}
