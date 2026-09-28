// A18/A20(spec §7):PiP 握手契约(protocolVersion=2/runtimeId=zcode-cua-pip-session-v2)+
// role 门客户端面(presentation 角色仅随握手/事件连接,工具方法不带 role)。
import assert from "node:assert/strict";
import test from "node:test";
import { createPipSessionClient, PIP_SESSION_PROTOCOL_VERSION, PIP_SESSION_RUNTIME_ID } from "../pip-session-node.js";
import { startMockHelper } from "./helpers/mock-helper.mjs";

test("A20 握手:protocolVersion=2 + runtimeId 逐字,ready 才 enabled", async () => {
  const helper = await startMockHelper({
    handlers: {
      pip_session_handshake: (params) => {
        assert.equal(params.protocolVersion, 2);
        assert.equal(params.runtimeId, "zcode-cua-pip-session-v2");
        return { ready: true };
      },
    },
  });
  try {
    const client = createPipSessionClient({ socketPath: helper.socketPath, timeoutMs: 2000 });
    await client.connect();
    assert.equal(client.enabled, true);
    const call = helper.calls.find((entry) => entry.method === "pip_session_handshake");
    assert.ok(call, "握手必须发出 pip_session_handshake");
    client.close();
    assert.equal(client.enabled, false);
  } finally {
    await helper.close();
  }
});

test("A20 握手被拒(ready:false)即抛,不静默启用", async () => {
  const helper = await startMockHelper({
    handlers: { pip_session_handshake: () => ({ ready: false }) },
  });
  try {
    const client = createPipSessionClient({ socketPath: helper.socketPath, timeoutMs: 2000 });
    await assert.rejects(() => client.connect());
    assert.equal(client.enabled, false);
  } finally {
    await helper.close();
  }
});

test("A18 事件连接带 role=presentation;helper 拒绝时不冒充成功", async () => {
  const helper = await startMockHelper({
    handlers: {
      pip_session_handshake: () => ({ ready: true }),
      pip_session_event: () => ({
        __error: {
          code: "not_authorized",
          message: "PiP session methods require presentation authority",
        },
      }),
    },
  });
  try {
    const client = createPipSessionClient({ socketPath: helper.socketPath, timeoutMs: 2000 });
    await client.connect();
    const auth = helper.calls.find((entry) => entry.method === "authenticate");
    assert.equal(auth.params.role, "presentation", "presentation 角色必须随 authenticate 声明(R15)");
    await assert.rejects(() =>
      client.send({
        kind: "session-closed",
        sessionId: "s-1",
      }),
    );
  } finally {
    await helper.close();
  }
});

test("未连接 send 即 {applied:false}(不虚报)", async () => {
  const client = createPipSessionClient({ socketPath: "unused-socket-path", timeoutMs: 500 });
  const result = await client.send({ kind: "session-closed", sessionId: "s-1" });
  assert.deepEqual(result, { applied: false, reason: "not_connected" });
});

test("A20 常量面:协议版本/runtimeId 钉死", () => {
  assert.equal(PIP_SESSION_PROTOCOL_VERSION, 2);
  assert.equal(PIP_SESSION_RUNTIME_ID, "zcode-cua-pip-session-v2");
});
