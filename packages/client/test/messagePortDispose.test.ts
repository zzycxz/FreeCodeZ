// 0-7 修复测试（升级实施手册）：connectViaMessagePort 旧签名只回 services，把带 dispose
// 的连接对象丢成不可达——基础 port 的 ChannelClient 与底层 port 永远无法释放。
// 修复后返回完整连接对象；dispose 幂等且真正解绑 port（removeEventListener + close）。
import assert from "node:assert/strict";
import test from "node:test";
import { connectViaMessagePort } from "../src/messageport.js";

class FakeMessagePort {
  listeners = new Map<string, Set<(event: { data: unknown }) => void>>();
  closed = false;
  started = false;

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    if (type !== "message") throw new Error(`unexpected listener type: ${type}`);
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
  }

  removeEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }

  postMessage(): void {
    // ChannelClient 初始化握手会发消息，测试不驱动对端，仅需不抛错。
  }
}

test("connectViaMessagePort 返回带 dispose 的完整连接对象", () => {
  const port = new FakeMessagePort();
  const connection = connectViaMessagePort(port as unknown as MessagePort);
  assert.ok(connection.services, "连接对象必须携带 services 访问器");
  assert.equal(typeof connection.dispose, "function", "连接对象必须携带 dispose");
});

test("dispose 释放底层 port（解绑监听 + close）且幂等", () => {
  const port = new FakeMessagePort();
  const connection = connectViaMessagePort(port as unknown as MessagePort);
  assert.ok(port.listeners.get("message")?.size ?? 0 > 0, "构造后 port 上应有 message 监听");
  connection.dispose();
  assert.equal(port.closed, true, "dispose 必须关闭底层 port");
  assert.equal(port.listeners.get("message")?.size ?? 0, 0, "dispose 必须解绑 message 监听");
  // 幂等：二次 dispose 不抛错（换代路径可能重入）。
  connection.dispose();
  assert.equal(port.closed, true);
});
