// B2 门禁:工具层策略链(subagent 双拒/kill switch/单控制器租约)、possibly_sent 归一、
// broker_response_ambiguous、CUA_NOT_READY、D1 收敛、A5 索引位移 fail-closed。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createComputerUseRuntime } from "../index.js";
import { captureAppFixture, CONTEXT, startMockHelper } from "./helpers/mock-helper.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function runtimeFor(socketPath) {
  return createComputerUseRuntime({ brokerSocketPath: socketPath, platform: "win32", settleWindowMs: 0 });
}

function parseTextJson(result) {
  return JSON.parse(result.content.find((block) => block.type === "text").text);
}

test("R3 双拒:subagent 上下文拒绝,文案与桥侧逐字一致", async () => {
  const runtime = runtimeFor("\\\\.\\pipe\\unused");
  const result = await runtime.execute({
    toolName: "list_apps",
    arguments: {},
    context: { ...CONTEXT, runtimeScope: "subagent" },
  });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Computer Use is not available in subagent");
  assert.equal(result.structuredContent.code, "SUBAGENT_COMPUTER_USE_UNAVAILABLE");
});

test("严格 schema:未声明键拒绝(unrecognized_keys),未知工具拒绝", async () => {
  const runtime = runtimeFor("\\\\.\\pipe\\unused");
  const bad = await runtime.execute({
    toolName: "left_click",
    arguments: { target: { type: "element", index: 0 }, bogus: 1 },
    context: CONTEXT,
  });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /unrecognized_keys/);
  assert.equal(bad.structuredContent.code, "invalid_request");

  const unknown = await runtime.execute({ toolName: "open_application", context: CONTEXT });
  assert.equal(unknown.isError, true);
});

test("R5 kill switch:stop 幂等闩锁,豁免 request_access/stop", async () => {
  const helper = await startMockHelper({
    handlers: {
      cancel_input_holds: () => null,
      broker_info: () => ({ pid: 1, authorization_subject: "h", platform: "win32" }),
      request_access: () => ({ accessibility: "granted", screenRecording: "granted" }),
    },
  });
  try {
    const runtime = runtimeFor(helper.socketPath);
    const stopped = await runtime.execute({
      toolName: "stop_computer_control",
      arguments: { reason: "user" },
      context: CONTEXT,
    });
    const payload = parseTextJson(stopped);
    assert.equal(payload.stopped, true);
    assert.equal(payload.reason, "user");
    assert.equal(payload.guard.stopped, true);
    assert.ok(
      helper.methods().includes("cancel_input_holds"),
      "stop 必须释放按键保持/虚拟指针(R5)",
    );

    const blocked = await runtime.execute({
      toolName: "left_click",
      arguments: { target: { type: "element", index: 0 } },
      context: CONTEXT,
    });
    assert.equal(blocked.isError, true);
    assert.equal(blocked.structuredContent.code, "CONTROL_STOPPED");
    assert.match(blocked.content[0].text, /CONTROL_STOPPED/);

    // 豁免面仍可用;重复 stop 幂等,不覆盖首个 reason。
    const access = await runtime.execute({ toolName: "request_access", arguments: {}, context: CONTEXT });
    assert.notEqual(access.isError, true);
    const again = await runtime.execute({
      toolName: "stop_computer_control",
      arguments: { reason: "other" },
      context: CONTEXT,
    });
    assert.equal(parseTextJson(again).reason, "user");
  } finally {
    await helper.close();
  }
});

test("R6 request_access:side_effects 全 false,快照+guard 形状", async () => {
  const helper = await startMockHelper({
    handlers: {
      broker_info: () => ({ pid: 5, authorization_subject: "sub", platform: "win32" }),
      request_access: () => ({ accessibility: "granted", screenRecording: "denied", grant_owner: "user" }),
    },
  });
  try {
    const runtime = runtimeFor(helper.socketPath);
    const result = await runtime.execute({ toolName: "request_access", arguments: {}, context: CONTEXT });
    const payload = parseTextJson(result);
    assert.deepEqual(payload.side_effects, {
      permission_prompted: false,
      automation_warmup_attempted: false,
      screen_capture_attempted: false,
    });
    assert.equal(payload.broker.connected, true);
    assert.equal(payload.guard.stopped, false);
    assert.deepEqual(payload.requested_capabilities, []);
  } finally {
    await helper.close();
  }
});

test("R4 单控制器租约:会话 B 报 controller_busy(带 owner,never),观测不受影响", async () => {
  const helper = await startMockHelper({
    handlers: {
      capture_app: () => captureAppFixture(),
      click: () => ({ action_sent: true, dispatch_status: "dispatched" }),
      list_applications: () => ({ apps: [{ pid: 1, name: "A", bundle_id: "a.b", active: true }] }),
    },
  });
  try {
    const runtime = runtimeFor(helper.socketPath);
    await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { pid: 42 }, include_screenshot: true },
      context: CONTEXT,
    });
    const first = await runtime.execute({
      toolName: "left_click",
      arguments: { target: { type: "coordinate", x: 1, y: 1 }, app_ref: { pid: 42 } },
      context: CONTEXT,
    });
    assert.notEqual(first.isError, true, JSON.stringify(first));

    const busy = await runtime.execute({
      toolName: "left_click",
      arguments: { target: { type: "coordinate", x: 2, y: 2 }, app_ref: { pid: 42 } },
      context: { ...CONTEXT, sessionId: "session-2" },
    });
    assert.equal(busy.isError, true);
    assert.equal(busy.structuredContent.code, "controller_busy");
    assert.equal(busy.structuredContent.details.owner.sessionId, "session-1");

    // 只读观测不占租约。
    const observed = await runtime.execute({ toolName: "list_apps", arguments: {}, context: { ...CONTEXT, sessionId: "session-2" } });
    assert.notEqual(observed.isError, true);
  } finally {
    await helper.close();
  }
});

test("possibly_sent 收据归一:非 error + dispatch_status 携带(SDK assertOk 升级输入面)", async () => {
  const helper = await startMockHelper({
    handlers: {
      capture_app: () => captureAppFixture(),
      click: () => ({ action_sent: true, dispatch_status: "possibly_sent", resolved_app_ref: { pid: 42 } }),
    },
  });
  try {
    const runtime = runtimeFor(helper.socketPath);
    await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { pid: 42 }, include_screenshot: true },
      context: CONTEXT,
    });
    const result = await runtime.execute({
      toolName: "left_click",
      arguments: { target: { type: "coordinate", x: 3, y: 3 }, app_ref: { pid: 42 } },
      context: CONTEXT,
    });
    assert.notEqual(result.isError, true, "possibly_sent 必须保持非 error,由 SDK 升级");
    assert.equal(result.structuredContent.dispatch_status, "possibly_sent");
    assert.equal(result.structuredContent.action_sent, true);
  } finally {
    await helper.close();
  }
});

test("A8 broker_response_ambiguous:动作中断连 → CUA_NOT_READY(retryable:false,官方文案)", async () => {
  const helper = await startMockHelper({
    handlers: {
      capture_app: () => captureAppFixture(),
      click: () => ({ __destroy: true }),
    },
  });
  try {
    const runtime = runtimeFor(helper.socketPath);
    await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { pid: 42 }, include_screenshot: true },
      context: CONTEXT,
    });
    const result = await runtime.execute({
      toolName: "left_click",
      arguments: { target: { type: "coordinate", x: 4, y: 4 }, app_ref: { pid: 42 } },
      context: CONTEXT,
    });
    assert.notEqual(result.isError, true);
    const payload = parseTextJson(result);
    assert.equal(payload.kind, "CUA_NOT_READY");
    assert.equal(payload.reasonCode, "broker_response_ambiguous");
    assert.equal(payload.retryable, false);
    assert.equal(
      payload.message,
      "The Helper may have accepted this action, but its response was lost. Do not replay it automatically; observe the target state first.",
    );
  } finally {
    await helper.close();
  }
});

test("冷启动 not-ready:连接被拒 → broker_not_accepting(retryable:true)", async () => {
  const helper = await startMockHelper({});
  const deadPath = helper.socketPath;
  await helper.close();
  const runtime = runtimeFor(deadPath);
  const result = await runtime.execute({ toolName: "list_apps", arguments: {}, context: CONTEXT });
  const payload = parseTextJson(result);
  assert.equal(payload.reasonCode, "broker_not_accepting");
  assert.equal(payload.retryable, true);
});

test("get_app_state envelope:state_id/elements/树文本/image_ref 凭据成对", async () => {
  const helper = await startMockHelper({ handlers: { capture_app: () => captureAppFixture() } });
  try {
    const runtime = runtimeFor(helper.socketPath);
    const result = await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { pid: 42 }, include_screenshot: true },
      context: CONTEXT,
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const state = result.structuredContent;
    assert.equal(state.state_id, "h-1");
    assert.equal(state.elements.length, 2);
    assert.ok(state.app && state.window);
    assert.match(state.text, /\[0\] button OK/);

    const texts = result.content.filter((block) => block.type === "text").map((block) => block.text);
    const imageBlocks = result.content.filter((block) => block.type === "image");
    assert.equal(imageBlocks.length, 1);
    const imageRefText = texts.find((text) => text.includes('"image_ref"'));
    const imageRef = JSON.parse(imageRefText).image_ref;
    assert.deepEqual(Object.keys(imageRef).sort(), ["actionable", "frame_id", "height", "width"]);
    assert.equal(imageRef.width, 20);
    assert.equal(imageRef.height, 10);
  } finally {
    await helper.close();
  }
});

test("元素动作:语义 AXPress 优先(附录 A.1 映射)", async () => {
  const calls = [];
  const helper = await startMockHelper({
    handlers: {
      capture_app: () => captureAppFixture(),
      element_perform_action: (params) => {
        calls.push(params);
        return { action_sent: true, dispatch_status: "dispatched" };
      },
    },
  });
  try {
    const runtime = runtimeFor(helper.socketPath);
    await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { pid: 42 }, tree_shown_to_model: true },
      context: CONTEXT,
    });
    const clicked = await runtime.execute({
      toolName: "left_click",
      arguments: { target: { type: "element", index: 0 }, app_ref: { pid: 42 } },
      context: CONTEXT,
    });
    assert.notEqual(clicked.isError, true, JSON.stringify(clicked));
    assert.deepEqual(calls[0], { native: "ax-1", action: "AXPress" });
  } finally {
    await helper.close();
  }
});

test("A5 索引位移:隐藏观察换树后旧 index fail-closed(element_unavailable,reobserve 语义)", async () => {
  const reordered = captureAppFixture([
    {
      role: "AXTextField",
      kind: "textfield",
      title: "Name",
      value: "hello",
      bounds: [10, 40, 200, 24],
      actions: [],
      native: "ax-2",
      owner_pid: 42,
    },
    {
      role: "AXStaticText",
      kind: "text",
      title: "Gone",
      value: null,
      bounds: [0, 0, 5, 5],
      actions: [],
      native: "ax-9",
      owner_pid: 42,
    },
  ]);
  const helper = await startMockHelper({
    handlers: {
      capture_app: (params) =>
        params.tree_shown_to_model === false ? reordered : captureAppFixture(),
      element_perform_action: () => ({ action_sent: true, dispatch_status: "dispatched" }),
    },
  });
  try {
    const runtime = runtimeFor(helper.socketPath);
    await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { pid: 42 }, tree_shown_to_model: true },
      context: CONTEXT,
    });
    // 隐藏观察(App 绑定/截图同款)把树换掉:index 0 从 ax-1(OK) 变成 ax-2(Name)。
    await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { pid: 42 }, tree_shown_to_model: false },
      context: CONTEXT,
    });
    const clicked = await runtime.execute({
      toolName: "left_click",
      arguments: { target: { type: "element", index: 0 }, app_ref: { pid: 42 } },
      context: CONTEXT,
    });
    assert.equal(clicked.isError, true, JSON.stringify(clicked));
    assert.equal(clicked.structuredContent.code, "element_unavailable");
    assert.match(clicked.content[0].text, /no longer refers to the element you saw there/);
  } finally {
    await helper.close();
  }
});

test("D1 收敛:实现面零产生 APP_NOT_FOUND/AMBIGUOUS_APP/SCREEN_LOCKED", () => {
  const dangling = ["APP_NOT_FOUND", "AMBIGUOUS_APP", "SCREEN_LOCKED"];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "test" || entry === "node_modules") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith(".js")) continue;
      const source = readFileSync(full, "utf8");
      for (const code of dangling) {
        if (source.includes(`"${code}"`) || source.includes(`'${code}'`)) offenders.push(`${entry}:${code}`);
      }
    }
  };
  walk(packageRoot);
  assert.deepEqual(offenders, []);
});
