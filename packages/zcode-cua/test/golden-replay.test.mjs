// A23/B2 门禁:金样本回放——官方 helper 实录的 wire 响应回放进本实现,
// 断言工具层 envelope 语义与附录 B 码面一致(金样本 = 断言基准,证据手册 I.2-1)。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createComputerUseRuntime } from "../index.js";
import { startMockHelper } from "./helpers/mock-helper.mjs";

const fixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "golden", "fixtures", "official-helper-win32.json"),
    "utf8",
  ),
);
const byName = new Map(fixture.cases.map((entry) => [entry.name, entry]));
const CONTEXT = { sessionId: "golden-replay", runtimeScope: "main", workspaceKey: "golden-ws" };

function responseOf(name) {
  const entry = byName.get(name);
  assert.ok(entry, `fixture missing case: ${name}`);
  return entry.response;
}

test("金样本:claim 语义(pre-auth broker_info 放行=exe 实测,勘误手册§3.5 绝对化表述)", () => {
  const response = responseOf("pre_auth_broker_info_claim_semantics");
  assert.equal(response.ok, true);
  assert.equal(typeof response.result.pid, "number");
  assert.match(String(response.result.bundle_id), /cua-helper/);
});

test("金样本:list_applications 裸数组 wire 形状 → 工具层 {apps:[...]}", async () => {
  const golden = responseOf("list_applications");
  assert.ok(Array.isArray(golden.result), "wire 形状必须是裸数组");
  const helper = await startMockHelper({
    handlers: { list_applications: () => golden.result },
  });
  try {
    const runtime = createComputerUseRuntime({
      brokerSocketPath: helper.socketPath,
      platform: "win32",
      settleWindowMs: 0,
    });
    const result = await runtime.execute({ toolName: "list_apps", arguments: {}, context: CONTEXT });
    assert.notEqual(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.apps.length, golden.result.length);
    assert.deepEqual(payload.apps[0], golden.result[0], "条目逐字段保真");
  } finally {
    await helper.close();
  }
});

test("金样本:capture_app 树场景 → envelope state/elements/树文本含金样元素", async () => {
  const golden = responseOf("capture_app_tree");
  assert.equal(golden.ok, true);
  const helper = await startMockHelper({
    handlers: { capture_app: () => golden.result },
  });
  try {
    const runtime = createComputerUseRuntime({
      brokerSocketPath: helper.socketPath,
      platform: "win32",
      settleWindowMs: 0,
    });
    const result = await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { pid: golden.result.app.pid ?? 42 }, tree_shown_to_model: true },
      context: CONTEXT,
    });
    assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 200));
    const state = result.structuredContent;
    assert.equal(state.state_id, golden.result.state_id, "state_id 保真");
    assert.equal(state.elements.length, golden.result.elements.length, "元素数保真");
    // 树文本渲染含金样首元素的语义行(标题/角色之一),渲染细节由差分 A23 逐字比对。
    const first = golden.result.elements[0];
    assert.ok(state.text.includes("[0]"), "树文本含索引行");
    if (first.title) assert.ok(state.text.includes(String(first.title).slice(0, 12)), "树文本含首元素标题");
  } finally {
    await helper.close();
  }
});

// 错误路径金样本(wire 方法 ↔ 工具一一对应):金样错误经工具层 envelope 码面保真。
// read_element 死 token / frame 伪造 / method_not_found 三例属 wire 级验证面,
// 工具层同语义为提前失败(未观察/无帧,官方同文案),由 fixture 码面断言 + tool-runtime 覆盖。
const ERROR_CASES = [
  ["error/not_settable", "set_value", "element_set_value", "not_settable"],
  ["error/not_selectable", "select_text", "element_select_text", "not_selectable"],
  ["error/text_too_long", "type", "type_text", "invalid_request"],
];
for (const [caseName, toolName, wireMethod, expectedCode] of ERROR_CASES) {
  test(`金样本错误路径:${caseName} → wire code ${expectedCode} 保真`, async () => {
    const golden = responseOf(caseName);
    assert.equal(golden.ok, false, "错误例必须是 ok:false");
    assert.equal(golden.error.code, expectedCode, "金样本自身码面");
    const capture = responseOf("capture_app_tree");
    const helper = await startMockHelper({
      handlers: {
        capture_app: () => capture.result,
        [wireMethod]: () => ({ __error: golden.error }),
      },
    });
    try {
      const runtime = createComputerUseRuntime({
        brokerSocketPath: helper.socketPath,
        platform: "win32",
        settleWindowMs: 0,
      });
      await runtime.execute({
        toolName: "get_app_state",
        arguments: { app_ref: { pid: capture.result.app.pid ?? 42 }, tree_shown_to_model: true },
        context: CONTEXT,
      });
      const args =
        toolName === "type"
          ? { text: "x".repeat(2000) }
          : toolName === "select_text"
            ? { target: { type: "element", index: 0 }, text_range: [0, 1] }
            : { target: { type: "element", index: 0 }, value: "x" };
      const result = await runtime.execute({ toolName, arguments: args, context: CONTEXT });
      assert.equal(result.isError, true, JSON.stringify(result).slice(0, 200));
      assert.equal(result.structuredContent.code, expectedCode, "工具层 envelope 码面保真");
    } finally {
      await helper.close();
    }
  });
}

test("金样本 wire 级例:read_element 死 token / frame 伪造 / method_not_found 码面", () => {
  assert.equal(responseOf("error/element_unavailable_bad_token").error.code, "element_unavailable");
  assert.equal(responseOf("error/bad_frame_provenance").error.code, "permission_denied");
  assert.equal(responseOf("error/method_not_found").error.code, "method_not_found");
});
test("金样本:version_mismatch 码面(documented 附录 B 行)", () => {
  const golden = responseOf("error/client_api_version_mismatch");
  assert.equal(golden.error.code, "version_mismatch");
});

test("金样本:PiP 角色门错误文案(A18 契约面)", () => {
  const golden = responseOf("error/pip_session_requires_presentation");
  assert.equal(golden.error.code, "not_authorized");
  assert.match(golden.error.message, /presentation authority/i);
});
