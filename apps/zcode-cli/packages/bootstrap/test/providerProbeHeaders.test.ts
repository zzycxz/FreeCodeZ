// 0-8 修复测试（升级实施手册）：官方 Anthropic 端点强制要求 anthropic-version 头（缺失一律
// 401），探测链此前只发 x-api-key + Bearer——设置向导测官方 key 会被误报 invalid-key。
// 用本地回环 HTTP 服务捕获真实请求头钉死三头齐发；chat 链由 AI SDK 自动带头不受影响。
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { probeProviderAccess } from "../src/zcode-protocol/provider-access-probe.js";

function withHeaderCapturingServer(
  handler: (headers: Record<string, string | string[] | undefined>) => { status: number; body?: string },
  run: (port: number) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const result = handler(request.headers);
        response.statusCode = result.status;
        response.end(result.body ?? "{}");
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      run(port)
        .then(() => {
          server.close(() => resolve());
        })
        .catch((error) => {
          server.close(() => reject(error));
        });
    });
  });
}

test("anthropic 探测请求携带 anthropic-version 头", async () => {
  let captured: Record<string, string | string[] | undefined> | undefined;
  await withHeaderCapturingServer(
    (headers) => {
      captured = headers;
      return { status: 200, body: JSON.stringify({ data: [] }) };
    },
    async (port) => {
      const result = await probeProviderAccess({
        apiType: "anthropic-messages",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: "sk-ant-test",
      });
      assert.equal(result.ok, true, "带版本头的探测应通过");
    },
  );
  assert.ok(captured, "服务端必须捕获到请求头");
  assert.equal(captured["anthropic-version"], "2023-06-01");
  assert.equal(captured["x-api-key"], "sk-ant-test");
  assert.equal(captured["authorization"], "Bearer sk-ant-test");
});

test("openai 兼容探测不带 anthropic 头（互不污染）", async () => {
  let captured: Record<string, string | string[] | undefined> | undefined;
  await withHeaderCapturingServer(
    (headers) => {
      captured = headers;
      return { status: 200, body: JSON.stringify({ data: [] }) };
    },
    async (port) => {
      const result = await probeProviderAccess({
        apiType: "openai-chat-completions",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: "sk-test",
      });
      assert.equal(result.ok, true);
    },
  );
  assert.equal(captured?.["anthropic-version"], undefined, "openai 链不应带 anthropic-version");
  assert.equal(captured?.["authorization"], "Bearer sk-test");
});
