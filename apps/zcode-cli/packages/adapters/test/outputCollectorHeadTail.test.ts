// B3 head-tail 截断单测：inline 缓冲改为首尾各半保留 + 中段 omitted 计数。
// 验收：①超限输出首尾标记同见且计数正确；②未超限行为与旧实现逐字节一致；
// ③恰好跨 head/tail 容量边界；④head|tail 拼接处切断的多字节 UTF-8 被裁掉。
import assert from "node:assert/strict";
import test from "node:test";
import { OutputCollector } from "../src/exec/output-collector.js";

function makeCollector(maxInlineBytes: number, options: Partial<{
  maxPersistedBytes: number;
  outputPath: string;
  persistOutput: "always" | "on_truncate" | "never";
}> = {}): OutputCollector {
  return new OutputCollector({
    maxInlineBytes,
    maxPersistedBytes: options.maxPersistedBytes ?? 0,
    legacyOutputEncoding: null,
    maxTailBytes: 0,
    outputPath: options.outputPath,
    persistOutput: options.persistOutput ?? "never",
  });
}

test("未超限：单 chunk 与分批 chunk 均逐字节一致、不标记截断", () => {
  const payload = Buffer.from("HEAD|#".repeat(100) + "|TAIL");
  const single = makeCollector(payload.byteLength + 10);
  single.append(payload);
  assert.equal(single.result().text, payload.toString("utf8"));
  assert.equal(single.result().truncated, false);

  const batched = makeCollector(payload.byteLength + 10);
  for (const piece of [payload.subarray(0, 77), payload.subarray(77, 200), payload.subarray(200)]) {
    batched.append(piece);
  }
  assert.equal(batched.result().text, payload.toString("utf8"));
  assert.equal(batched.result().truncated, false);
});

test("超限：首尾同见 + omitted 计数正确（验收场景）", () => {
  const collector = makeCollector(30); // head 15 + tail 15
  const head = Buffer.from("HEAD-START|||");
  const tail = Buffer.from("|||TAIL-END!");
  const middle = Buffer.alloc(1000, 0x61); // 'a' * 1000
  collector.append(head);
  collector.append(middle);
  collector.append(tail);
  const result = collector.result();
  assert.equal(result.truncated, true);
  assert.ok(result.text.startsWith("HEAD-START|||"), "头部应保留");
  assert.ok(result.text.endsWith("|||TAIL-END!"), "尾部应保留");
  assert.ok(result.text.includes("bytes omitted"), "应含省略计数标记");
  // bytes 总量 = 13 + 1000 + 12；omitted = 总量 - head保留 - tail保留 = 1025 - 13 - 12
  assert.equal(result.bytes, 1025);
  // omitted = 总量 - head 保留(15) - tail 保留(15) = 995；head 尾部容纳 2 个 'a'，
  // tail 前缀容纳 3 个 'a' + 尾标记 12B。
  assert.equal(result.omittedBytes, 995);
});

test("恰好跨边界：head 满后尾窗能容纳的全部后续输出不标记截断", () => {
  const collector = makeCollector(30); // head 15 + tail 15
  collector.append(Buffer.alloc(15, 0x62)); // head 恰满
  collector.append(Buffer.alloc(15, 0x63)); // 尾窗恰好装下
  const result = collector.result();
  assert.equal(result.truncated, false);
  assert.equal(result.text, "b".repeat(15) + "c".repeat(15));
});

test("多字节 UTF-8 在拼接处被裁剪：无替换字符，裁剪计入 omitted", () => {
  const collector = makeCollector(24); // head 12 + tail 12
  // "中" = 3 字节。head 塞 5 个"中"(15B)→前 12B 进 head（第 5 个被切断），
  // 尾窗装最后 12 字节（4 个完整"中"），中段省略。
  collector.append(Buffer.from("中".repeat(40)));
  const result = collector.result();
  assert.equal(result.truncated, true);
  assert.ok(!result.text.includes("\uFFFD"), "不得出现替换字符");
  assert.ok(result.text.startsWith("中".repeat(4)), "head 裁剪到完整字符边界");
  assert.ok(result.text.endsWith("中".repeat(4)), "tail 从完整字符边界开始");
  assert.ok((result.omittedBytes ?? 0) > 0);
});

test("truncated 收紧语义：head 满后无新增输出则不标记（旧行为会误标）", () => {
  const collector = makeCollector(30);
  collector.append(Buffer.alloc(20, 0x64));
  assert.equal(collector.result().truncated, false);
});
