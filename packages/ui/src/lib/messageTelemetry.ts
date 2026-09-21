/* FreeCodeZ fork 惰性空壳(P3 §3.3):数仓事件上报已删;所有导出为 no-op/any。
   保留导出面避免全 UI 调用点改动;物理移除留待品牌清扫批次。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type AgentStepRole = any;
export type PromptMessageSource = any;
export function activateDetachedAgentStepTelemetry(..._a: unknown[]): any {
  return undefined;
}
export function activatePromptTelemetry(..._a: unknown[]): any {
  return undefined;
}
export function buildCompactionTelemetryExtraDetail(..._a: unknown[]): any {
  return undefined;
}
export function buildPromptTelemetryExtraDetail(..._a: unknown[]): any {
  return undefined;
}
export function composeAgentComposition(..._a: unknown[]): any {
  return undefined;
}
export function discardPromptTelemetry(..._a: unknown[]): any {
  return undefined;
}
export function discardQueuedPromptTelemetry(..._a: unknown[]): any {
  return undefined;
}
export function finalizePromptTelemetry(..._a: unknown[]): any {
  return undefined;
}
export function getActivePromptMessageId(..._a: unknown[]): any {
  return undefined;
}
export function getActivePromptModelName(..._a: unknown[]): any {
  return undefined;
}
export function queuePromptTelemetry(..._a: unknown[]): any {
  return undefined;
}
export function recordAgentStepTelemetryEvent(..._a: unknown[]): any {
  return undefined;
}
export function recordComposerFocus(..._a: unknown[]): any {
  return undefined;
}
export function recordComposerTextChange(..._a: unknown[]): any {
  return undefined;
}
export function recordPromptModelRequestStarted(..._a: unknown[]): any {
  return undefined;
}
export function recordPromptPermissionRequest(..._a: unknown[]): any {
  return undefined;
}
export function recordPromptPermissionResponse(..._a: unknown[]): any {
  return undefined;
}
export function recordPromptTokenUsageDelta(..._a: unknown[]): any {
  return undefined;
}
export function recordSubagentToolAttribution(..._a: unknown[]): any {
  return undefined;
}
