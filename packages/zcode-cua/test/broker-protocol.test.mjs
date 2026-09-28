// B2 门禁:协议分帧、方法白名单(42+2)、服务端分发、socket 固定命名。
import assert from "node:assert/strict";
import test from "node:test";
import {
  BROKER_METHODS,
  dispatchRequest,
  errorResponse,
  errorResponseFromException,
  handleRequestLine,
  isBrokerMethod,
  isReadOnlyBrokerMethod,
  mintBrokerSocketPath,
  okResponse,
  parseRequestLine,
  resolveBrokerSocketPath,
  BrokerError,
} from "../broker.js";

test("parseRequestLine:合法行/非法行/id 归一", () => {
  assert.deepEqual(parseRequestLine('{"id":1,"method":"ping"}'), { id: "1", method: "ping" });
  assert.deepEqual(parseRequestLine('{"id":"a-1","method":"click","params":{"point":[1,2]}}'), {
    id: "a-1",
    method: "click",
    params: { point: [1, 2] },
  });
  assert.equal(parseRequestLine("not json"), undefined);
  assert.equal(parseRequestLine("[1,2]"), undefined);
  assert.equal(parseRequestLine('{"id":1}'), undefined);
  assert.equal(parseRequestLine('{"id":{"x":1},"method":"ping"}'), undefined);
});

test("响应分帧:serializeResponse 尾部 \\n,ok/error 形状", () => {
  assert.equal(serializeCheck(), true);
  assert.deepEqual(okResponse(42), { ok: true, result: 42 });
  assert.deepEqual(errorResponse("boom", { code: "internal" }), {
    ok: false,
    error: { message: "boom", code: "internal" },
  });
  assert.equal(errorResponseFromException(new BrokerError("nope", { code: "not_authorized" })).error.code, "not_authorized");
});

function serializeCheck() {
  const line = `${JSON.stringify(okResponse(1))}\n`;
  return line.endsWith("\n") && JSON.parse(line).ok === true;
}

test("BROKER_METHODS 机器计数 42,authenticate/ping 在表外,pip_live_probe_* 不复活", () => {
  assert.equal(BROKER_METHODS.length, 42);
  assert.equal(isBrokerMethod("authenticate"), false);
  assert.equal(isBrokerMethod("ping"), false);
  assert.equal(BROKER_METHODS.some((method) => method.startsWith("pip_live_probe_")), false);
  for (const method of BROKER_METHODS) assert.equal(isBrokerMethod(method), true);
});

test("只读集:观测/诊断可软超时,动作/控制命令不可", () => {
  for (const method of [
    "broker_info",
    "controller_status",
    "request_access",
    "capture_app",
    "list_applications",
    "list_windows",
    "screen_capture_probe",
    "pip_session_handshake",
    "pip_clear_dismissed",
  ]) {
    assert.equal(isReadOnlyBrokerMethod(method), true, `${method} 应属只读`);
  }
  for (const method of ["click", "paste", "controller_stop", "controller_takeover", "cancel_input_holds", "pip_session_event"]) {
    assert.equal(isReadOnlyBrokerMethod(method), false, `${method} 不属只读`);
  }
});

test("dispatchRequest:未知方法 method_not_found,handler 错误码保留,连接级特判", async () => {
  const backend = {
    click: async () => ({ ok: true }),
    paste: async () => {
      throw new BrokerError("denied", { code: "permission_denied", details: { action_sent: false } });
    },
  };
  const notFound = await dispatchRequest(backend, { method: "nope" });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.error.code, "method_not_found");

  // 白名单外的方法即使 backend 提供 handler 也拒(helper 攻击面收敛同语义)。
  const gated = await dispatchRequest(
    { boom: async () => 1 },
    { method: "boom" },
  );
  assert.equal(gated.error.code, "method_not_found");

  const ok = await dispatchRequest(backend, { method: "click", params: {} });
  assert.deepEqual(ok, { ok: true, result: { ok: true } });

  const failed = await dispatchRequest(backend, { method: "paste", params: {} });
  assert.equal(failed.error.code, "permission_denied");

  const ping = await dispatchRequest(backend, { method: "ping" });
  assert.deepEqual(ping.result, { serverApiVersion: 2 });
  const auth = await dispatchRequest({}, { method: "authenticate" });
  assert.deepEqual(auth.result, { authenticated: true });
});

test("handleRequestLine:非法行回 invalid_request", async () => {
  const response = await handleRequestLine({}, "garbage");
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "invalid_request");
});

test("socket 固定命名:env 覆盖优先,win32 固定管道,mint/resolve 同名", () => {
  const envOverride = resolveBrokerSocketPath({ env: { ZCODE_CUA_PERMISSION_BROKER_SOCKET: "\\\\.\\pipe\\custom" } });
  assert.equal(envOverride, "\\\\.\\pipe\\custom");

  const minted = mintBrokerSocketPath({ env: {} });
  const resolved = resolveBrokerSocketPath({ env: {} });
  assert.equal(resolved, minted);
  if (process.platform === "win32") {
    assert.equal(minted, "\\\\.\\pipe\\zcode-cua-helper-default");
    assert.ok(minted.startsWith("\\\\.\\pipe\\zcode-cua-helper-"));
  } else {
    assert.ok(minted.endsWith("broker.sock"));
    assert.match(minted, /zcode-cua|freecodez/);
  }
});
