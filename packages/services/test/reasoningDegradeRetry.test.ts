import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runGenerateWithReasoningDegrade,
  runStreamWithReasoningDegrade,
} from "@zcode/adapters/model";

// spec §2.3 L1 行为测试：只重试一次、流式仅"零事件"失败才重试、无降级目标不重试。
type DegradedRequest = Parameters<typeof runGenerateWithReasoningDegrade>[0];

function makeRequest(reasoningLevel: string): DegradedRequest {
  // 被测函数只消费 options.reasoningLevel 与对象展开，其余字段按最小结构提供。
  return { options: { maxOutputTokens: 1024, reasoningLevel } } as unknown as DegradedRequest;
}

test("整段生成：推理参数被拒时以安全档重试一次（自定义阶梯降最低档）", async () => {
  const seen: string[] = [];
  const run = async (request: DegradedRequest) => {
    seen.push(request.options.reasoningLevel);
    if (seen.length === 1) throw new Error("Invalid 'reasoning_effort': 'xhigh'");
    return "ok";
  };
  const result = await runGenerateWithReasoningDegrade(
    makeRequest("xhigh"),
    run,
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.equal(result, "ok");
  assert.deepEqual(seen, ["xhigh", "low"]);
});

test("整段生成：非推理参数错误（鉴权）不重试", async () => {
  let calls = 0;
  await assert.rejects(
    runGenerateWithReasoningDegrade(
      makeRequest("xhigh"),
      async () => {
        calls += 1;
        throw new Error("401 Unauthorized: invalid api key");
      },
      ["low", "medium", "high"],
    ),
    /401/,
  );
  assert.equal(calls, 1);
});

test("整段生成：无可降目标（单档已用）不重试", async () => {
  let calls = 0;
  await assert.rejects(
    runGenerateWithReasoningDegrade(
      makeRequest("disabled"),
      async () => {
        calls += 1;
        throw new Error("reasoning_effort must be one of: low");
      },
      ["disabled"],
    ),
  );
  assert.equal(calls, 1);
});

test("流式：未流出任何事件即失败才降级重试，正文不重复", async () => {
  const seen: string[] = [];
  const run = (request: DegradedRequest) =>
    (async function* () {
      seen.push(request.options.reasoningLevel);
      if (seen.length === 1) throw new Error("Unknown parameter: 'reasoning_effort'");
      yield "event-1";
      yield "event-2";
    })();
  const events: string[] = [];
  for await (const event of runStreamWithReasoningDegrade(
    makeRequest("enabled"),
    run,
    ["disabled", "enabled"],
  )) {
    events.push(event);
  }
  assert.deepEqual(events, ["event-1", "event-2"]);
  assert.deepEqual(seen, ["enabled", "disabled"]);
});

test("流式：已流出事件后失败不重试，原样上抛", async () => {
  let calls = 0;
  const run = (request: DegradedRequest) =>
    (async function* () {
      calls += 1;
      void request;
      yield "event-1";
      throw new Error("reasoning_effort is not supported");
    })();
  const events: string[] = [];
  await assert.rejects(
    async () => {
      for await (const event of runStreamWithReasoningDegrade(
        makeRequest("xhigh"),
        run,
        ["low", "high"],
      )) {
        events.push(event);
      }
    },
    /not supported/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(events, ["event-1"]);
});
