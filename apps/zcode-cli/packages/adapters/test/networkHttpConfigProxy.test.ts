// 代理出口解析的 loopback 直连规则单测（spec: docs/spec/model-provider-intake-and-expansion.md
// §P2.4-3，验收 B6）。本地模型服务（Ollama/LM Studio/llama.cpp）的请求不得经代理转发：
// 代理服务器无法访问用户本机回环地址，走代理只会失败。该规则在 resolveProxyForRequest
// 内部无条件生效，chat（model-execution）、探测（provider-access-probe）、MCP、WebFetch
// 共用同一解析器，单一真源。
import assert from "node:assert/strict";
import test from "node:test";
import { ZCODE_HTTP_PROXY_ENV_KEY } from "@zcode/shared";
import { resolveProxyForRequest, resolveWebFetchProxyForRequest } from "../src/network/http-config.js";

test("loopback 目标无条件直连：显式 httpProxy 也不转发（B6）", () => {
  for (const url of [
    "http://127.0.0.1:11434/v1/chat/completions",
    "http://localhost:1234/v1/models",
    "http://[::1]:8080/api/tags",
  ]) {
    const resolution = resolveProxyForRequest(url, { httpProxy: "http://127.0.0.1:7890" });
    assert.equal(resolution.noProxyMatched, true, url);
    assert.equal(resolution.proxyUrl, undefined, url);
  }
});

test("非 loopback 目标仍走显式 httpProxy（直连规则不外溢）", () => {
  const resolution = resolveProxyForRequest("https://api.siliconflow.cn/v1/models", {
    httpProxy: "http://127.0.0.1:7890",
  });
  assert.equal(resolution.noProxyMatched, false);
  assert.equal(resolution.proxyUrl, "http://127.0.0.1:7890/");
});

test("loopback 目标不受 env 代理影响（探测/发现路径）", () => {
  const resolution = resolveProxyForRequest("http://127.0.0.1:11434/api/tags", {
    env: { [ZCODE_HTTP_PROXY_ENV_KEY]: "http://127.0.0.1:7890" },
  });
  assert.equal(resolution.noProxyMatched, true);
  assert.equal(resolution.proxyUrl, undefined);
});

test("非 loopback 目标的 env 代理路径保持可用", () => {
  const resolution = resolveProxyForRequest("https://api.stepfun.com/v1/models", {
    env: { [ZCODE_HTTP_PROXY_ENV_KEY]: "http://127.0.0.1:7890" },
  });
  assert.equal(resolution.proxyUrl, "http://127.0.0.1:7890/");
});

test("显式 noProxy token 对非 loopback 目标仍然生效（既有行为不回归）", () => {
  const resolution = resolveProxyForRequest("https://internal.example.com/v1/models", {
    httpProxy: "http://127.0.0.1:7890",
    noProxy: "internal.example.com",
  });
  assert.equal(resolution.noProxyMatched, true);
  assert.equal(resolution.proxyUrl, undefined);
});

test("webfetch 解析路径同样应用 loopback 直连", () => {
  const resolution = resolveWebFetchProxyForRequest("http://localhost:3000/docs", {
    httpProxy: "http://127.0.0.1:7890",
  });
  assert.equal(resolution.noProxyMatched, true);
  assert.equal(resolution.proxyUrl, undefined);
});
