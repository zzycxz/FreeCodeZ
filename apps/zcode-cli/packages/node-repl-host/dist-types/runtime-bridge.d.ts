import type { BrowserClientTransport } from "@zcode/core/browser-client";
export declare const NODE_REPL_BROWSER_BRIDGE_SYMBOL: unique symbol;
export declare const BROWSER_UNAVAILABLE_IN_SUBAGENT_MESSAGE = "Browser is not available in subagent";
export interface NodeReplBrowserRuntimeBridge extends BrowserClientTransport {
    documentationRoot: string;
    assertAvailable(): void;
}
export declare function readNodeReplBrowserRuntimeBridge(globals: Record<PropertyKey, unknown>): NodeReplBrowserRuntimeBridge;
export declare const NODE_REPL_COMPUTER_BRIDGE_SYMBOL: unique symbol;
export declare const COMPUTER_UNAVAILABLE_IN_SUBAGENT_MESSAGE = "Computer control is not available in subagent";
export interface NodeReplComputerRuntimeBridge {
    documentationRoot: string;
    assertAvailable(): void;
    sdk(): unknown;
    dispose(): Promise<void>;
}
export declare function readNodeReplComputerRuntimeBridge(globals: Record<PropertyKey, unknown>): NodeReplComputerRuntimeBridge;
//# sourceMappingURL=runtime-bridge.d.ts.map