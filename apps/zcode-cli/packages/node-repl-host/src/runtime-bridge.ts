import type { BrowserClientTransport } from "@zcode/core/browser-client";

export const NODE_REPL_BROWSER_BRIDGE_SYMBOL = Symbol.for("zcode.node-repl.browser-control-bridge");
export const BROWSER_UNAVAILABLE_IN_SUBAGENT_MESSAGE = "Browser is not available in subagent";

export interface NodeReplBrowserRuntimeBridge extends BrowserClientTransport {
  documentationRoot: string;
  assertAvailable(): void;
}

export function readNodeReplBrowserRuntimeBridge(
  globals: Record<PropertyKey, unknown>,
): NodeReplBrowserRuntimeBridge {
  const bridge = globals[NODE_REPL_BROWSER_BRIDGE_SYMBOL];
  if (!bridge || typeof bridge !== "object") {
    throw new Error(
      "Browser runtime bridge is unavailable. Use Browser from a ZCode desktop or shared-host session.",
    );
  }
  return bridge as NodeReplBrowserRuntimeBridge;
}

export const NODE_REPL_COMPUTER_BRIDGE_SYMBOL = Symbol.for("freecodez.node-repl.computer-use-bridge");
export const COMPUTER_UNAVAILABLE_IN_SUBAGENT_MESSAGE = "Computer control is not available in subagent";

export interface NodeReplComputerRuntimeBridge {
  documentationRoot: string;
  assertAvailable(): void;
  sdk(): unknown;
  dispose(): Promise<void>;
}

export function readNodeReplComputerRuntimeBridge(
  globals: Record<PropertyKey, unknown>,
): NodeReplComputerRuntimeBridge {
  const bridge = globals[NODE_REPL_COMPUTER_BRIDGE_SYMBOL];
  if (!bridge || typeof bridge !== "object") {
    throw new Error(
      "Computer runtime bridge is unavailable. Use computer control from a FreeCodeZ desktop session with the engine enabled.",
    );
  }
  return bridge as NodeReplComputerRuntimeBridge;
}
