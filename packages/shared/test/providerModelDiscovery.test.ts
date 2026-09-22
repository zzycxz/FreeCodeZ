// 模型列表发现纯逻辑的单测（spec: docs/spec/model-provider-intake-and-expansion.md §P2.7）。
// 覆盖候选 URL 链、双格式解码、非 chat 过滤、赢家 base 回写（含 anthropic 不回写与
// ollama-tags 补 /v1 两条边界）与 endpoint-miss 判定；本模块无 IO，直接测纯函数。
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildModelListCandidates,
  decodeModelList,
  filterChatModelIds,
  isModelEndpointMissStatus,
  resolveWinnerBaseUrl,
} from "../src/provider-model-discovery.js";

test("buildModelListCandidates: openai 系 base 带 /v1 时只有 {base}/models 单候选", () => {
  const candidates = buildModelListCandidates(
    "openai-chat-completions",
    "https://api.siliconflow.cn/v1",
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.url),
    ["https://api.siliconflow.cn/v1/models"],
  );
});

test("buildModelListCandidates: openai 系 base 缺 /v1 时顺序回退到根 /v1/models", () => {
  const candidates = buildModelListCandidates(
    "openai-chat-completions",
    "https://api.siliconflow.cn",
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.url),
    ["https://api.siliconflow.cn/models", "https://api.siliconflow.cn/v1/models"],
  );
});

test("buildModelListCandidates: loopback 先 Ollama 原生 /api/tags，再 /v1/models 兜底", () => {
  const candidates = buildModelListCandidates("openai-chat-completions", "http://127.0.0.1:11434/v1");
  assert.deepEqual(
    candidates.map((candidate) => candidate.url),
    ["http://127.0.0.1:11434/api/tags", "http://127.0.0.1:11434/v1/models"],
  );
  assert.equal(candidates[0]?.kind, "ollama-tags");
});

test("buildModelListCandidates: anthropic-messages 剥兼容后缀后从根拼 /v1/models", () => {
  assert.deepEqual(
    buildModelListCandidates("anthropic-messages", "https://qianfan.baidubce.com/anthropic").map(
      (candidate) => candidate.url,
    ),
    ["https://qianfan.baidubce.com/v1/models", "https://qianfan.baidubce.com/anthropic/models"],
  );
  assert.deepEqual(
    buildModelListCandidates(
      "anthropic-messages",
      "https://dashscope.aliyuncs.com/apps/anthropic",
    ).map((candidate) => candidate.url),
    [
      "https://dashscope.aliyuncs.com/v1/models",
      "https://dashscope.aliyuncs.com/apps/anthropic/models",
    ],
  );
});

test("buildModelListCandidates: 显式 modelsUrl 独占单候选（models_url 配置语义）", () => {
  const candidates = buildModelListCandidates(
    "openai-chat-completions",
    "https://example.com/v1",
    "https://example.com/custom/model-list",
  );
  assert.deepEqual(candidates, [
    { url: "https://example.com/custom/model-list", kind: "models-json" },
  ]);
});

test("decodeModelList: OpenAI data[].id 优先，空白/非字符串 id 剔除", () => {
  assert.deepEqual(
    decodeModelList({ data: [{ id: "m1" }, { id: "  " }, {}, { id: "m2" }] }),
    ["m1", "m2"],
  );
});

test("decodeModelList: Ollama models[].name 兜底，name 缺失时认 model", () => {
  assert.deepEqual(decodeModelList({ models: [{ name: "llama3" }, { model: "qwen2" }] }), [
    "llama3",
    "qwen2",
  ]);
});

test("decodeModelList: 结构合法的空目录返回 []（端点存在而无模型），垃圾负载返回 null", () => {
  assert.deepEqual(decodeModelList({ data: [] }), []);
  assert.deepEqual(decodeModelList({ models: [] }), []);
  assert.equal(decodeModelList({ foo: 1 }), null);
  assert.equal(decodeModelList("nope"), null);
});

test("filterChatModelIds: 非 chat 黑名单命中项剔除且去重保序", () => {
  assert.deepEqual(
    filterChatModelIds([
      "gpt-4o",
      "text-embedding-3-large",
      "bge-reranker-v2-m3",
      "tts-1",
      "qwen-max",
      "gpt-4o",
    ]),
    ["gpt-4o", "qwen-max"],
  );
});

test("resolveWinnerBaseUrl: anthropic-messages 不回写（防 /v1/v1 风险位）", () => {
  const winner = { url: "https://qianfan.baidubce.com/v1/models", kind: "models-json" } as const;
  assert.equal(
    resolveWinnerBaseUrl(winner, "https://qianfan.baidubce.com/anthropic", "anthropic-messages"),
    "https://qianfan.baidubce.com/anthropic",
  );
});

test("resolveWinnerBaseUrl: openai 系赢家多 /v1 时回写修正", () => {
  const winner = { url: "https://api.siliconflow.cn/v1/models", kind: "models-json" } as const;
  assert.equal(
    resolveWinnerBaseUrl(winner, "https://api.siliconflow.cn", "openai-chat-completions"),
    "https://api.siliconflow.cn/v1",
  );
});

test("resolveWinnerBaseUrl: 赢家与用户 base 一致时仅剥尾斜杠", () => {
  const winner = { url: "https://api.siliconflow.cn/v1/models", kind: "models-json" } as const;
  assert.equal(
    resolveWinnerBaseUrl(winner, "https://api.siliconflow.cn/v1/", "openai-responses"),
    "https://api.siliconflow.cn/v1",
  );
});

test("resolveWinnerBaseUrl: ollama-tags 赢家在 base 缺 /vN 时补 /v1（Ollama chat 路径）", () => {
  const winner = { url: "http://127.0.0.1:11434/api/tags", kind: "ollama-tags" } as const;
  assert.equal(
    resolveWinnerBaseUrl(winner, "http://127.0.0.1:11434", "openai-chat-completions"),
    "http://127.0.0.1:11434/v1",
  );
});

test("resolveWinnerBaseUrl: ollama-tags 赢家在 base 已带 /v1 时保持不变", () => {
  const winner = { url: "http://127.0.0.1:11434/api/tags", kind: "ollama-tags" } as const;
  assert.equal(
    resolveWinnerBaseUrl(winner, "http://127.0.0.1:11434/v1/", "openai-chat-completions"),
    "http://127.0.0.1:11434/v1",
  );
});

test("isModelEndpointMissStatus: 仅 404/405 视为端点缺失可回退", () => {
  assert.equal(isModelEndpointMissStatus(404), true);
  assert.equal(isModelEndpointMissStatus(405), true);
  assert.equal(isModelEndpointMissStatus(401), false);
  assert.equal(isModelEndpointMissStatus(429), false);
  assert.equal(isModelEndpointMissStatus(500), false);
  assert.equal(isModelEndpointMissStatus(200), false);
});
