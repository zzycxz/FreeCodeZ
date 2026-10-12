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
/** sidecar 候选路径（纯函数，测试直测）。三级布局：
 * - 打包态（G1，2026-10-11 装机审计修复）：server 从插件缓存跑
 *   （…/cache/freecodez/node-repl-host/<ver>/dist/mcp），相对候选全够不着——锚定
 *   process.resourcesPath（node_repl 由 Electron Helper-as-node 拉起，resourcesPath
 *   指向 app Resources，与 prepare-agent-node-bundle 的 glm/packages/computer-engine-dist
 *   staging 布局对齐）。缓存换版本也不受影响（读 app 资产而非缓存副本）。
 * - 打包 staging 布局（dist→node-repl-host→packages→根，包旁 computer-engine-dist）。
 * - 开发态（src→node-repl-host→packages→zcode-cli→apps→根，或 dev 构建产物 dist/mcp
 *   →上五层=apps→packages/computer-engine/dist）。 */
export declare function sidecarCandidatePaths(input: {
    here: string;
    resourcesPath?: string | undefined;
}): string[];
/** W-28/P3（V1.19）：光标 HUD 帧出口——SDK 输入事件旁路单播到本机 HUD 监听
 * （desktop cuaCursorHud 绑 127.0.0.1:53717；FREECODEZ_CUA_CURSOR_BROADCAST_PORT 可覆盖）。
 * 惰性建 socket；发送失败静默吞（可视化旁路不折断动作本体，同 emitCursorEvents 口径）。 */
export declare function createCursorHudBroadcaster(env?: NodeJS.ProcessEnv): {
    emit(event: unknown): void;
    close(): void;
};
export declare function createComputerBridgeGlobals(input: {
    generation: number;
    getActiveCall: () => ActiveComputerCall | undefined;
    session: () => ComputerBridgeSession;
}): Record<PropertyKey, unknown>;
//# sourceMappingURL=computer-bridge.d.ts.map