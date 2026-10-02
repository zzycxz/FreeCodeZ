// C4 单测：headless 失败退出码——projection.status=error → 1，其余 → 0；
// --no-fail-on-error 恢复旧行为（恒 0）。三个输出格式（text/json/stream-json）
// 共用同一判定。
import assert from "node:assert/strict";
import test from "node:test";
import { exitCodeForProjection } from "../src/prompt-command.js";

test("error 状态 → 退出码 1", () => {
  assert.equal(exitCodeForProjection("error", {}), 1);
});

test("非 error 状态（completed/idle/waiting/paused/running）→ 退出码 0", () => {
  for (const status of ["completed", "idle", "waiting", "paused", "running"]) {
    assert.equal(exitCodeForProjection(status, {}), 0, `${status} 应为 0`);
  }
});

test("--no-fail-on-error 恢复旧行为：error 也退出 0", () => {
  assert.equal(exitCodeForProjection("error", { noFailOnError: true }), 0);
});
