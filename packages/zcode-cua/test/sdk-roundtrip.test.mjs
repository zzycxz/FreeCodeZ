// B2 门禁:官方 vendored SDK ↔ 本实现 runtime ↔ mock helper 全链回环。
// 锁定 envelope 契约(appStateOf/receiptOf/notReadyEnvelopeOf 解析面)与
// possibly_sent→TIMEOUT 升级路径(附录 B/B2-5;升级只发生在 Target API 的 assertOk,
// computer.* 直调按 SDK 设计原样解封收据给模型自检)。
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ComputerUseError,
  setupComputerUseRuntime,
} from "../../../apps/zcode-cli/dependencies/zcode-cua/plugin/scripts/computer-use-client.mjs";
import { createComputerUseRuntime } from "../index.js";
import { captureAppFixture, startMockHelper } from "./helpers/mock-helper.mjs";

const BRIDGE_SYMBOL = Symbol.for("zcode.node-repl.computer-use-bridge");
const CONTEXT = { sessionId: "sdk-1", runtimeScope: "main", workspaceKey: "ws-1" };

function fakeGlobals(runtime) {
  const writes = [];
  return {
    writes,
    globals: {
      [BRIDGE_SYMBOL]: {
        call: (method, args) =>
          runtime.execute({ toolName: method, arguments: args ?? {}, context: CONTEXT }),
        assertAvailable() {},
        documentationRoot: join(dirname(fileURLToPath(import.meta.url)), ".."),
      },
      nodeRepl: {
        write(text) {
          writes.push(text);
        },
        emitStructuredResult() {},
      },
      agent: {},
    },
  };
}

test("SDK 回环:listApps 解封 + getAXState 树文本经 state.text", async () => {
  const helper = await startMockHelper({
    handlers: {
      list_applications: () => ({
        apps: [{ pid: 42, name: "Example", bundle_id: "com.example.App", active: true }],
      }),
      capture_app: () => captureAppFixture(),
    },
  });
  try {
    const runtime = createComputerUseRuntime({
      brokerSocketPath: helper.socketPath,
      platform: "win32",
      settleWindowMs: 0,
    });
    const { globals, writes } = fakeGlobals(runtime);
    const cua = await setupComputerUseRuntime({ globals });

    const apps = await cua.listApps();
    assert.equal(apps.length, 1);
    assert.equal(apps[0].pid, 42);

    const app = await cua.getApp({ pid: 42 });
    const tree = await app.getAXState();
    assert.match(tree, /\[0\] button OK/);
    assert.ok(writes.length > 0, "观察结果应自行展示(emitText)");
  } finally {
    await helper.close();
  }
});

test("SDK 回环:possibly_sent 收据升级 ComputerUseError{TIMEOUT, actionSent:true, reobserve}", async () => {
  const helper = await startMockHelper({
    handlers: {
      capture_app: () => captureAppFixture(),
      click: () => ({ action_sent: true, dispatch_status: "possibly_sent" }),
    },
  });
  try {
    const runtime = createComputerUseRuntime({
      brokerSocketPath: helper.socketPath,
      platform: "win32",
      settleWindowMs: 0,
    });
    const { globals } = fakeGlobals(runtime);
    const cua = await setupComputerUseRuntime({ globals });
    // 先取一次带截图的观察,给会话留一帧可动作栅格(坐标目标的隐式帧绑定)。
    await cua.computer.get_app_state({
      app_ref: { pid: 42 },
      include_screenshot: true,
      tree_shown_to_model: true,
    });
    const app = await cua.getApp({ pid: 42 });
    await assert.rejects(
      () => app.click([3, 3]),
      (error) => {
        assert.ok(error instanceof ComputerUseError);
        assert.equal(error.code, "TIMEOUT");
        assert.equal(error.actionSent, true);
        assert.equal(error.retry, "reobserve");
        return true;
      },
    );
  } finally {
    await helper.close();
  }
});

test("SDK 回环:helper 显式错误码经附录 B 映射(element_unavailable→ELEMENT_UNAVAILABLE,reobserve)", async () => {
  const helper = await startMockHelper({
    handlers: {
      capture_app: () => captureAppFixture(),
      element_set_value: () => ({
        __error: {
          code: "element_unavailable",
          message: "token is gone",
          details: { action_sent: false },
        },
      }),
    },
  });
  try {
    const runtime = createComputerUseRuntime({
      brokerSocketPath: helper.socketPath,
      platform: "win32",
      settleWindowMs: 0,
    });
    const { globals } = fakeGlobals(runtime);
    const cua = await setupComputerUseRuntime({ globals });
    const app = await cua.getApp({ pid: 42 });
    await assert.rejects(
      () => app.setValue(1, "x"),
      (error) => {
        assert.ok(error instanceof ComputerUseError);
        assert.equal(error.code, "ELEMENT_UNAVAILABLE");
        assert.equal(error.retry, "reobserve");
        assert.equal(error.actionSent, false);
        return true;
      },
    );
  } finally {
    await helper.close();
  }
});
