// W-25/G.2 错误映射全覆盖测试：21 个引擎错误码 → SDK 码 + 重试类 + possibly_sent。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapEngineError, ComputerUseSdkError } from "../src/sdk/errors";

// G.2 映射表：引擎错误码 → SDK 码 + 重试类 + possibly_sent。
const G2_MATRIX: Array<[string, string, string, boolean]> = [
  ["element_not_found", "ELEMENT_UNAVAILABLE", "reobserve", false],
  ["element_not_clickable", "ELEMENT_UNAVAILABLE", "reobserve", false],
  ["window_not_found", "WINDOW_STALE", "reobserve", false],
  ["window_stale", "WINDOW_STALE", "reobserve", false],
  ["app_not_found", "INVALID_APP", "reobserve", false],
  ["app_blocked", "app_blocked", "never", false],
  ["permission_denied", "permission_denied", "never", false],
  ["provider_incompatible", "provider_incompatible", "never", false],
  ["value_not_settable", "NOT_SETTABLE", "never", false],
  ["action_not_supported", "ACTION_UNAVAILABLE", "never", false],
  ["invalid_argument", "INVALID_REQUEST", "never", false],
  ["unsupported_capability", "unsupported_capability", "retry", false],
  ["accessibility_error", "accessibility_error", "retry", false],
  ["screenshot_failed", "screenshot_failed", "retry", false],
  // possibly_sent 族（G.2 信封语义）
  ["action_timeout", "TIMEOUT", "never", true],
  // window_not_focused 分叉：已送达语义 vs 纯聚焦失败
  ["window_not_focused:delivered", "FOREGROUND_REQUIRED", "never", true],
  ["window_not_focused:plain", "FOREGROUND_REQUIRED", "reobserve", false],
  // 引擎不可用族（R7 fail-closed）
  ["unsupported_capability:no-native", "CUA_NOT_READY", "retry", false],
  // 未知码兜底
  ["unknown_code", "INVALID_REQUEST", "never", false],
  [undefined as unknown as string, "INVALID_REQUEST", "never", false],
];

describe("G.2 错误映射全覆盖（21 例）", () => {
  for (const [engineCode, sdkCode, retry, possiblySent] of G2_MATRIX) {
    it(`${engineCode ?? "(no code)"} → ${sdkCode} (${retry}, possiblySent=${possiblySent})`, () => {
      // window_not_focused 分叉：message 判定
      let message = "";
      if (engineCode === "window_not_focused:delivered") {
        message = "1 press(es) may already have been delivered";
      } else if (engineCode === "window_not_focused:plain") {
        message = "window is not focused";
      } else if (engineCode === "unsupported_capability:no-native") {
        message = "computer-use has no native provider for darwin";
      }
      const code = engineCode?.startsWith("window_not_focused:")
        ? "window_not_focused"
        : engineCode === "unsupported_capability:no-native"
          ? "unsupported_capability"
          : engineCode;
      const mapping = mapEngineError(code, message);
      assert.strictEqual(mapping.sdkCode, sdkCode);
      assert.strictEqual(mapping.retry, retry);
      assert.strictEqual(mapping.possiblySent, possiblySent);
    });
  }

  it("ComputerUseSdkError 携带 source 源码", () => {
    const err = new ComputerUseSdkError(
      { sdkCode: "WINDOW_STALE", retry: "reobserve", possiblySent: false },
      "window gone",
      "window_not_found",
    );
    assert.strictEqual(err.sdkCode, "WINDOW_STALE");
    assert.strictEqual(err.source, "window_not_found");
  });
});
