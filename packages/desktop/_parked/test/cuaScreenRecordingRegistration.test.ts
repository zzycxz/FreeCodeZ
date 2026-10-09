// R21b 主应用录屏自注册（共享件）测试：
// ① 已授权不请求；② 未授权发起请求并记日志；③ probe/请求抛错 fail-soft 不向上抛。
import assert from "node:assert/strict";
import test from "node:test";
import { ensureMainScreenRecordingRegistration } from "../main/cuaScreenRecordingRegistration.js";

test("R21b：已授权不请求；未授权请求一次并记日志", () => {
  const calls: string[] = [];
  const logs: Array<{ message: string; context?: Record<string, unknown> }> = [];
  const deps = {
    requestScreenCaptureAccess: () => {
      calls.push("request");
      return { granted: true };
    },
    log: (message: string, context?: Record<string, unknown>) => {
      logs.push({ message, context });
    },
  };

  assert.equal(
    ensureMainScreenRecordingRegistration({ ...deps, probeScreenCapture: () => true }),
    false,
    "已授权不发起请求",
  );
  assert.deepEqual(calls, []);

  assert.equal(
    ensureMainScreenRecordingRegistration({ ...deps, probeScreenCapture: () => false }),
    true,
    "未授权发起请求",
  );
  assert.deepEqual(calls, ["request"]);
  assert.ok(
    logs.some(
      (entry) =>
        entry.message.includes("self-registration attempted") &&
        entry.context?.event === "cua.screen_capture_request",
    ),
  );
});

test("R21b：probe/请求抛错 fail-soft，不向上抛", () => {
  const logs: string[] = [];
  assert.equal(
    ensureMainScreenRecordingRegistration({
      probeScreenCapture: () => {
        throw new Error("probe boom");
      },
      log: (message) => logs.push(message),
    }),
    false,
  );
  assert.equal(
    ensureMainScreenRecordingRegistration({
      probeScreenCapture: () => false,
      requestScreenCaptureAccess: () => {
        throw new Error("request boom");
      },
      log: (message) => logs.push(message),
    }),
    false,
  );
  assert.equal(logs.filter((message) => message.includes("failed")).length, 2);
});
