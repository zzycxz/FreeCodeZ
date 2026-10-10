// FreeCodeZ W-14 引导面（FC 自有件）：模型面 js 工具的 Computer Use 引导函数。
// 与 Browser Use 的 setupBrowserRuntime 同构：从 Symbol.for 全局取桥，构造 SDK
// facade 挂到 globals.agent.computer。模型面 SKILL 教：
//   const { setupComputerUseRuntime } = await import(<engine>/sdk/setup.js);
//   await setupComputerUseRuntime({ globals: globalThis });
//   const computer = globalThis.agent.computer;
export const NODE_REPL_COMPUTER_BRIDGE_SYMBOL_KEY = "freecodez.node-repl.computer-use-bridge";

export interface ComputerBridgeTransport {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface ComputerBridgeShape {
  assertAvailable(): void;
  sdk(): Promise<unknown>;
  documentationRoot: string;
  dispose(): Promise<void>;
}

/** 模型面 Computer Use facade（G.1 工具编排方法面）。 */
export interface ComputerRuntime {
  capabilities(): Promise<unknown>;
  listApps(): Promise<unknown>;
  listWindows(input: { app: string }): Promise<unknown>;
  getAppState(input: Record<string, unknown>): Promise<unknown>;
  leftClick(input: Record<string, unknown>): Promise<unknown>;
  scroll(input: Record<string, unknown>): Promise<unknown>;
  drag(input: Record<string, unknown>): Promise<unknown>;
  type(input: Record<string, unknown>): Promise<unknown>;
  setValue(input: Record<string, unknown>): Promise<unknown>;
  selectText(input: Record<string, unknown>): Promise<unknown>;
  key(input: Record<string, unknown>): Promise<unknown>;
  performAction(input: Record<string, unknown>): Promise<unknown>;
  paste(input: Record<string, unknown>): Promise<unknown>;
  requestAccess(input?: Record<string, unknown>): Promise<unknown>;
  stop(reason: string): unknown;
  elementFocus(input: Record<string, unknown>): Promise<unknown>;
  readElement(input: Record<string, unknown>): Promise<unknown>;
  elementAtPoint(input: Record<string, unknown>): Promise<unknown>;
}

export async function setupComputerUseRuntime(opts: {
  globals: Record<string, unknown>;
}): Promise<ComputerRuntime> {
  const bridge = (opts.globals as Record<PropertyKey, unknown>)[
    Symbol.for(NODE_REPL_COMPUTER_BRIDGE_SYMBOL_KEY)
  ] as ComputerBridgeShape | undefined;
  if (!bridge || typeof bridge !== "object") {
    throw new Error(
      "Computer runtime bridge is unavailable. Use computer control from a FreeCodeZ desktop session with the engine enabled.",
    );
  }
  bridge.assertAvailable();
  const sdk = (await bridge.sdk()) as ComputerRuntime;
  const agent = (opts.globals.agent ??= {}) as Record<string, unknown>;
  agent.computer = sdk;
  return sdk;
}
