// FreeCodeZ fork(P3 §3.2):遥测包已删;入口准备/关闭均无操作。
// 导出面保留为 no-op,调用点物理移除留待品牌清扫批次。
export async function prepareZCodeTelemetryEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  return env;
}

export async function shutdownZCodeTelemetry(): Promise<void> {}
