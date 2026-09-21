// FreeCodeZ fork(P3 §3.2):Agent 遥测 spawn env 注入已删;恒返回空对象。
interface BuildAgentTelemetrySpawnEnvInput {
  telemetryEnv: Record<string, string>;
  deviceMid?: string;
  userId?: string;
  runtimeSurface: "desktop_local_host" | "remote_workspace_host";
}

export function buildAgentTelemetrySpawnEnv(
  _input: BuildAgentTelemetrySpawnEnvInput,
): Record<string, string> {
  return {};
}

export function readZCodeAgentTelemetryEnv(_env: NodeJS.ProcessEnv): Record<string, string> {
  return {};
}
