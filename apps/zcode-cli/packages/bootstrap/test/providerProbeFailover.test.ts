// 0C-3①（P0-2，升级实施手册）：探测链 5xx 回退。旧版把首个候选的 5xx 当终态
//（statusToErrorKind→unknown 立即失败），候选 2 明明可用也不试；5xx 是端点瞬时/路由态，
// 与 404/405 同等换候选，全链皆 5xx 才按最后状态失败。
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { probeProviderAccess } from "../src/zcode-protocol/provider-access-probe.js";

function withStatusServer(
  statuses: number[],
  run: (port: number) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let hit = 0;
    const server = createServer((request, response) => {
      const status = statuses[Math.min(hit, statuses.length - 1)] ?? 200;
      hit += 1;
      response.statusCode = status;
      response.end(status === 200 ? JSON.stringify({ data: [] }) : "err");
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      run(port)
        .then(() => server.close(() => resolve()))
        .catch((error) => server.close(() => reject(error)));
    });
  });
}

test("5xx 回退：首个候选 503，第二形态候选 200 → 探测通过", async () => {
  await withStatusServer([503, 200], async (port) => {
    // baseUrl 无 /v1 → 候选 1 = base/models（503），候选 2 = 根/v1/models。
    // 两个候选 URL 形态不同但都打到同一测试服务（status 序列驱动）。
    const result = await probeProviderAccess({
      apiType: "openai-chat-completions",
      baseUrl: `http://127.0.0.1:${port}/compatible-mode/v1`,
      apiKey: "sk-test",
    });
    assert.equal(result.ok, true, "5xx 后必须换候选而不是终态失败");
  });
});

test("全链 5xx：按最后一个 5xx 状态结构化失败（不再误报 invalid-key）", async () => {
  await withStatusServer([500, 503], async (port) => {
    const result = await probeProviderAccess({
      apiType: "openai-chat-completions",
      baseUrl: `http://127.0.0.1:${port}/compatible-mode/v1`,
      apiKey: "sk-test",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.notEqual(result.errorKind, "invalid-key", "5xx 不得误报成 key 无效");
      assert.ok(result.message?.includes("503"), "按最后状态失败并说明全链 5xx");
    }
  });
});

test("401 仍立即失败（明确结论不换候选）", async () => {
  await withStatusServer([401], async (port) => {
    const result = await probeProviderAccess({
      apiType: "openai-chat-completions",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "sk-bad",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errorKind, "invalid-key");
  });
});
