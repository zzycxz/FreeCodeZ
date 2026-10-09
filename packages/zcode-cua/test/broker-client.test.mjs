// B2 门禁:NDJSON 客户端(authenticate 首请求/claim/错误映射入参/possibly_sent 判定)。
import assert from "node:assert/strict";
import test from "node:test";
import { BrokerError, callBrokerMethod, probeHelperHealth } from "../broker.js";
import { HELPER_BUNDLE_ID } from "../broker-helper-constants.js";
import { startMockHelper } from "./helpers/mock-helper.mjs";

test("callBrokerMethod:authenticate 必为首请求,随后才是业务方法", async () => {
  const helper = await startMockHelper({
    handlers: { broker_info: () => ({ pid: 123, authorization_subject: HELPER_BUNDLE_ID }) },
  });
  try {
    const info = await callBrokerMethod({ socketPath: helper.socketPath, method: "broker_info", params: {} });
    assert.equal(info.pid, 123);
    assert.deepEqual(helper.methods(), ["authenticate", "broker_info"]);
  } finally {
    await helper.close();
  }
});

test("probeHelperHealth:首次 broker_info 往返即认领,映射 bundleId/pid", async () => {
  const helper = await startMockHelper({
    handlers: { broker_info: () => ({ pid: 7, authorization_subject: HELPER_BUNDLE_ID }) },
  });
  try {
    const health = await probeHelperHealth(helper.socketPath, { timeoutMs: 3000, perTryTimeoutMs: 1000 });
    assert.deepEqual(health, { bundleId: HELPER_BUNDLE_ID, pid: 7 });
  } finally {
    await helper.close();
  }
});

test("helper 显式错误:code/details 原样进 BrokerError(附录 B 映射的输入面)", async () => {
  const helper = await startMockHelper({
    handlers: {
      click: () => ({
        __error: {
          code: "element_unavailable",
          message: "token is gone",
          details: { action_sent: false },
        },
      }),
    },
  });
  try {
    await assert.rejects(
      () => callBrokerMethod({ socketPath: helper.socketPath, method: "click", params: {} }),
      (error) => {
        assert.ok(error instanceof BrokerError);
        assert.equal(error.code, "element_unavailable");
        assert.equal(error.message, "token is gone");
        assert.equal(error.details.action_sent, false);
        assert.equal(error.details.request_delivery_state, "delivered");
        return true;
      },
    );
  } finally {
    await helper.close();
  }
});

test("possibly_sent 判定:请求已写出后断连 → request_delivery_state=possibly_sent", async () => {
  const helper = await startMockHelper({ handlers: { click: () => ({ __destroy: true }) } });
  try {
    await assert.rejects(
      () => callBrokerMethod({ socketPath: helper.socketPath, method: "click", params: {} }),
      (error) => {
        assert.equal(error.code, "broker_unavailable");
        assert.equal(error.details.request_delivery_state, "possibly_sent");
        return true;
      },
    );
  } finally {
    await helper.close();
  }
});

test("not_sent 判定:连接被拒 → request_delivery_state=not_sent", async () => {
  const helper = await startMockHelper({});
  const deadPath = helper.socketPath;
  await helper.close();
  await assert.rejects(
    () => callBrokerMethod({ socketPath: deadPath, method: "click", params: {} }),
    (error) => {
      assert.equal(error.code, "broker_unavailable");
      assert.equal(error.details.request_delivery_state, "not_sent");
      return true;
    },
  );
});

test("只读软超时语义:超时错误不冒充成功(动作类由调用方给 deadline)", async () => {
  const helper = await startMockHelper({ handlers: { broker_info: () => ({ __silent: true }) } });
  try {
    await assert.rejects(
      () =>
        callBrokerMethod({
          socketPath: helper.socketPath,
          method: "broker_info",
          params: {},
          timeoutMs: 60,
        }),
      (error) => {
        assert.equal(error.code, "timeout");
        assert.equal(error.details.request_delivery_state, "possibly_sent");
        return true;
      },
    );
  } finally {
    await helper.close();
  }
});
