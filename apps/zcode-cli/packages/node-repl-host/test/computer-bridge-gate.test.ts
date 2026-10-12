// V1.17 生效链桥层门回归：桌面设置总开关关（bootstrap 注入 FREECODEZ_CUA_DISABLED=1）时，
// setupComputerUseRuntime 必须显式报「设置关闭」——优先于 sidecar 产物检查。
// 产品开关拒绝与引擎未构建是两种失败面，分开报模型才能把正确处置转告用户。
import assert from "node:assert/strict";
import test from "node:test";
import { createComputerBridgeGlobals, NODE_REPL_COMPUTER_BRIDGE_SYMBOL } from "../src/computer-bridge.js";

function makeMainScopeGlobals() {
  return createComputerBridgeGlobals({
    generation: 1,
    getActiveCall: () => ({
      generation: 1,
      requestMeta: { runtime_scope: "main", session_id: "gate-test" } as never,
      runtimeScope: "main" as const,
      sessionId: "gate-test",
      signal: new AbortController().signal,
    }),
    session: () => ({ mergeResponseMeta: () => {} }),
  });
}

test("FREECODEZ_CUA_DISABLED=1：setupComputerUseRuntime 显式报设置关闭（优先于产物检查）", async () => {
  const previous = process.env.FREECODEZ_CUA_DISABLED;
  process.env.FREECODEZ_CUA_DISABLED = "1";
  try {
    const globals = makeMainScopeGlobals();
    const bridge = globals[NODE_REPL_COMPUTER_BRIDGE_SYMBOL] as { dispose(): Promise<void> };
    try {
      // ensureSdk 同步抛（门在 sidecar 解析之前），用 assert.throws。
      assert.throws(
        () => (globals.setupComputerUseRuntime as () => Promise<unknown>)(),
        /turned off in FreeCodeZ settings/,
      );
    } finally {
      await bridge.dispose();
    }
  } finally {
    if (previous === undefined) delete process.env.FREECODEZ_CUA_DISABLED;
    else process.env.FREECODEZ_CUA_DISABLED = previous;
  }
});
