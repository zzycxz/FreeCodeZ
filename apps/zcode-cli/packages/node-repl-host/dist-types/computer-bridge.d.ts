import type { NodeReplRequestMeta } from "@zcode/core/repl";
export { NODE_REPL_COMPUTER_BRIDGE_SYMBOL } from "./runtime-bridge.js";
export interface ActiveComputerCall {
    generation: number;
    requestMeta: NodeReplRequestMeta;
    runtimeScope: "main" | "subagent";
    sessionId: string;
    signal: AbortSignal;
}
export interface ComputerBridgeSession {
    mergeResponseMeta(meta: Record<string, unknown>): void;
}
export declare function createComputerBridgeGlobals(input: {
    generation: number;
    getActiveCall: () => ActiveComputerCall | undefined;
    session: () => ComputerBridgeSession;
}): Record<PropertyKey, unknown>;
//# sourceMappingURL=computer-bridge.d.ts.map