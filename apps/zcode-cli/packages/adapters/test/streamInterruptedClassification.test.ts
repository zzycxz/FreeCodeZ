// 0C-3③（升级实施手册）：上游在 SSE 帧中间断流时，anthropic compat 层旧版把半帧直通，
// 下游 JSON 解析崩成 InvalidModelResponse（不可重试）——网络中断被误标成坏响应。
// 修复：flush 以类型化 ModelStreamInterruptedError 终结流；分类器归 network_error（可重试）。
import assert from "node:assert/strict";
import test from "node:test";
import { classifyModelFailure } from "../src/model/failure-classifier.js";
import {
  createModelStreamInterruptedError,
  isModelStreamInterruptedError,
} from "../src/model/stream-interrupted.js";

test("类型识别：instanceof 与跨层 code 字符串双形态", () => {
  const error = createModelStreamInterruptedError({ pendingBytes: 42 });
  assert.ok(isModelStreamInterruptedError(error));
  // controller.error 会把错误包进流管道，跨层只认 code 字符串。
  assert.ok(isModelStreamInterruptedError({ code: "MODEL_STREAM_INTERRUPTED" }));
  assert.ok(!isModelStreamInterruptedError(new Error("plain")));
});

test("分类：流中断归 network_error 且可重试（不再误标坏响应）", () => {
  const failure = classifyModelFailure(createModelStreamInterruptedError({ pendingBytes: 10 }));
  assert.equal(failure.retryable, true, "网络中断必须可重试");
  assert.equal(failure.retryReason, "network_error");
  assert.notEqual(failure.code, "invalid_model_response", "不得再落进坏响应桶");
});
