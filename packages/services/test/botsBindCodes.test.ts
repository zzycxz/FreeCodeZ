// FreeCodeZ fork(Bots):绑定码 TTL 30s 过期 / 一次性 / 跨 bot 无效 / ttlMs 可配（R3，附录B §1.5 bind）。
// 运行: node --test packages/services/test/botsBindCodes.test.ts（经 tsx 加载源码）。
import assert from "node:assert/strict";
import test from "node:test";
import { BindCodeStore, DEFAULT_BIND_CODE_TTL_MS } from "../src/bots/bindCodes.js";

test("绑定码：6 位大写 HEX、默认 TTL 30s", () => {
  let clock = 1_000_000;
  const store = new BindCodeStore(() => clock);
  const record = store.create({ botId: "bot-1" });
  assert.match(record.code, /^[0-9A-F]{6}$/u);
  assert.equal(record.expiresAt, clock + DEFAULT_BIND_CODE_TTL_MS);
});

test("绑定码：30s 过期后不可用（bindCodeInvalid）", () => {
  let clock = 0;
  const store = new BindCodeStore(() => clock);
  const record = store.create({ botId: "bot-1" });
  clock = 29_999;
  assert.ok(store.consume(record.code, "bot-1"));
  const second = store.create({ botId: "bot-1" }); // expiresAt = 29_999 + 30_000
  clock = 59_999;
  assert.equal(store.consume(second.code, "bot-1"), null);
});

test("绑定码：一次性——成功核销后立即失效", () => {
  const store = new BindCodeStore();
  const record = store.create({ botId: "bot-1" });
  assert.ok(store.consume(record.code, "bot-1"));
  assert.equal(store.consume(record.code, "bot-1"), null);
});

test("绑定码：跨 bot 无效且不销毁（官方仅成功后 r.delete）", () => {
  let clock = 0;
  const store = new BindCodeStore(() => clock);
  const record = store.create({ botId: "bot-1" });
  assert.equal(store.consume(record.code, "bot-2"), null);
  // 错 bot 尝试后原 code 仍可用
  assert.ok(store.consume(record.code, "bot-1"));
});

test("绑定码：ttlMs 可配（R3）", () => {
  let clock = 0;
  const store = new BindCodeStore(() => clock);
  const record = store.create({ botId: "bot-1", ttlMs: 5_000 });
  assert.equal(record.expiresAt, 5_000);
  clock = 5_001;
  assert.equal(store.consume(record.code, "bot-1"), null);
});

test("绑定码：peek 不核销；clearBot 清理该 bot 全部 code", () => {
  const store = new BindCodeStore();
  const first = store.create({ botId: "bot-1" });
  const second = store.create({ botId: "bot-2" });
  assert.ok(store.peek(first.code));
  assert.ok(store.peek(first.code));
  store.clearBot("bot-1");
  assert.equal(store.consume(first.code, "bot-1"), null);
  assert.ok(store.consume(second.code, "bot-2"));
});

test("绑定码：code 大小写不敏感", () => {
  const store = new BindCodeStore();
  const record = store.create({ botId: "bot-1" });
  assert.ok(store.consume(record.code.toLowerCase(), "bot-1"));
});
