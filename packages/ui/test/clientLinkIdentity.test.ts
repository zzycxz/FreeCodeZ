// 链路身份推导（R6 / 上游修复①的规则面）单测：跨链路调用的 clientMode/deliveryKind
// 必须随真实链路走，禁止写死 desktop-continuous。
import assert from "node:assert/strict";
import test from "node:test";
import {
  adoptClientLinkMode,
  currentClientLinkIdentity,
  deriveClientLinkIdentity,
} from "../src/lib/clientLinkIdentity.js";

test("deriveClientLinkIdentity：两字段同值，随 isWebRemote 推导", () => {
  assert.deepEqual(deriveClientLinkIdentity(false), {
    clientMode: "desktop-continuous",
    deliveryKind: "desktop-continuous",
  });
  assert.deepEqual(deriveClientLinkIdentity(true), {
    clientMode: "web-remote-replayable",
    deliveryKind: "web-remote-replayable",
  });
});

test("currentClientLinkIdentity：默认 desktop，采纳 hello 后随真实链路", () => {
  adoptClientLinkMode("desktop-continuous");
  assert.deepEqual(currentClientLinkIdentity(), {
    clientMode: "desktop-continuous",
    deliveryKind: "desktop-continuous",
  });
  adoptClientLinkMode("web-remote-replayable");
  assert.deepEqual(currentClientLinkIdentity(), {
    clientMode: "web-remote-replayable",
    deliveryKind: "web-remote-replayable",
  });
  adoptClientLinkMode("desktop-continuous");
});
