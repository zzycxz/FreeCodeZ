// FreeCodeZ fork:进程名前缀换名(任务管理器可见);导出函数名 formatZCode* 为内部标识不动(规格书 P1 §4.6)。
const ZCODE_PROCESS_PREFIX = "freecodez";
const MAX_PROCESS_NAME_SEGMENT_LENGTH = 24;

function sanitizeProcessNameSegment(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, MAX_PROCESS_NAME_SEGMENT_LENGTH);
}

function joinZCodeProcessName(...segments: Array<string | null | undefined>): string {
  const sanitizedSegments = segments
    .map((segment) => sanitizeProcessNameSegment(segment))
    .filter((segment): segment is string => Boolean(segment));
  return [ZCODE_PROCESS_PREFIX, ...sanitizedSegments].join("-");
}

function pickWorkspaceTag(workspacePath: string | null | undefined): string | undefined {
  const trimmedPath = workspacePath?.trim();
  if (!trimmedPath) {
    return undefined;
  }

  const parts = trimmedPath.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? trimmedPath;
}

export function formatZCodeMainProcessName(): string {
  return joinZCodeProcessName("main");
}

export function formatZCodeGpuProcessName(): string {
  return joinZCodeProcessName("gpu");
}

export function formatZCodeHostProcessName(label?: string): string {
  return joinZCodeProcessName("host", label);
}

export function formatZCodeRendererProcessName(windowTitle?: string): string {
  const normalizedTitle = windowTitle?.trim();
  // FreeCodeZ fork:窗口标题判别字面量与 runtimeApplicationName/productName 联动,漏改则远程窗口进程名分派失配。
  if (!normalizedTitle || normalizedTitle === "FreeCodeZ") {
    return joinZCodeProcessName("renderer", "main");
  }

  if (normalizedTitle === "Resource Manager") {
    return joinZCodeProcessName("renderer", "resource-manager");
  }

  const remoteWindowPrefix = "FreeCodeZ - ";
  if (normalizedTitle.startsWith(remoteWindowPrefix)) {
    return joinZCodeProcessName(
      "renderer",
      "remote",
      normalizedTitle.slice(remoteWindowPrefix.length),
    );
  }

  return joinZCodeProcessName("renderer", normalizedTitle);
}

export function formatZCodeAgentProcessName(provider: string, workspacePath?: string): string {
  return joinZCodeProcessName("agent", provider, pickWorkspaceTag(workspacePath));
}

export function formatZCodeUtilityProcessName(name?: string, type = "utility"): string {
  return joinZCodeProcessName(type, name);
}
