// FreeCodeZ fork(2026-09-24 移动端远程控制):shared/web-remote-control 纯函数与 schema 单测——
// challenge-response 鉴权三件套、配对 URL 形态、桥身份三元组、rpc-frame/应用层 zod 约束。
// 合同见 docs/spec/web-remote-control.md §2/§5。
// 运行:node --import tsx --test packages/services/test/webRemoteControlProtocol.test.ts
import { parseMobileHelloFrame } from "../../server/src/relay/mobilePage.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPairingUrl,
  failureReasonI18nKeys,
  isRawTransportCandidate,
  isSameBridgeIdentity,
  resolveRelayWsUrl,
  resolveRemotePageUrl,
  rpcFrameSchema,
  appMessageSchema,
  WEB_REMOTE_CONTROL_LIMITS,
  buildWorkspaceKey,
} from "@zcode/shared/web-remote-control";
import {
  buildRelayAuthProof,
  generateRelayPassword,
  hashRelayPassword,
  verifyRelayAuthProof,
} from "@zcode/shared/web-remote-control/auth-node";

test("鉴权三件套:passHash 稳定、proof 可验证、篡改拒绝", () => {
  const password = generateRelayPassword();
  assert.equal(password.length > 0, true);
  const passHash = hashRelayPassword(password);
  assert.equal(hashRelayPassword(password), passHash, "同一口令派生同一 passHash");

  const proof = buildRelayAuthProof(passHash, "nonce-1", "sid-1");
  assert.equal(verifyRelayAuthProof(passHash, "nonce-1", "sid-1", proof), true);
  assert.equal(verifyRelayAuthProof(passHash, "nonce-2", "sid-1", proof), false, "nonce 不匹配必须拒绝");
  assert.equal(verifyRelayAuthProof(passHash, "nonce-1", "sid-2", proof), false, "sid 不匹配必须拒绝");
  assert.equal(verifyRelayAuthProof("bad-hash", "nonce-1", "sid-1", proof), false);
  assert.equal(verifyRelayAuthProof(passHash, "nonce-1", "sid-1", proof.slice(0, -1)), false);
});

test("配对 URL 形态:remote/v4 + sid&hash&t&mid&name&app_version", () => {
  const url = buildPairingUrl("https://relay.example/remote/v4", {
    sid: "S1",
    hash: "H1",
    t: 1700000000000,
    mid: "M1",
    name: "My%Desktop",
    app_version: "3.14.0",
  });
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/remote/v4");
  assert.equal(parsed.searchParams.get("sid"), "S1");
  assert.equal(parsed.searchParams.get("hash"), "H1");
  assert.equal(parsed.searchParams.get("t"), "1700000000000");
  assert.equal(parsed.searchParams.get("mid"), "M1");
  assert.equal(parsed.searchParams.get("name"), "My%Desktop");
  assert.equal(parsed.searchParams.get("app_version"), "3.14.0");
});

test("桥身份三元组全等判定", () => {
  const base = { bridgeSessionId: "b1", bridgeGeneration: 1, recoveryId: "r1" };
  assert.equal(isSameBridgeIdentity(base, { ...base }), true);
  assert.equal(isSameBridgeIdentity(base, { ...base, recoveryId: "r2" }), false);
  assert.equal(isSameBridgeIdentity(base, { ...base, bridgeGeneration: 2 }), false);
  assert.equal(isSameBridgeIdentity(base, { ...base, bridgeSessionId: "b2" }), false);
  assert.equal(
    isSameBridgeIdentity({ bridgeSessionId: "b" }, { bridgeSessionId: "b" }),
    true,
    "缺省 generation/recoveryId 归一后相等",
  );
});

test("workspaceKey 唯一构造规则:workspaceIdentity?.trim() || workspacePath", () => {
  assert.equal(buildWorkspaceKey(" id ", "/path"), "id");
  assert.equal(buildWorkspaceKey("   ", "/path"), "/path");
  assert.equal(buildWorkspaceKey(undefined, "/path"), "/path");
});

test("rpc-frame schema:分片约束与字节上限", () => {
  const frame = {
    zcode_type: "rpc-frame",
    bridgeSessionId: "b1",
    seq: 1,
    messageSeq: 1,
    fragmentIndex: 0,
    fragmentCount: 1,
    messageBytes: 10,
    checksum: { algorithm: "crc32", value: "0badf00d" },
    dataBase64: "AAAA",
  };
  assert.equal(rpcFrameSchema.safeParse(frame).success, true);
  assert.equal(
    rpcFrameSchema.safeParse({ ...frame, fragmentIndex: 1, fragmentCount: 1 }).success,
    false,
    "fragmentIndex 必须 < fragmentCount",
  );
  assert.equal(
    rpcFrameSchema.safeParse({ ...frame, fragmentCount: 20, messageBytes: 2 }).success,
    false,
    "fragmentCount 必须 <= messageBytes",
  );
  assert.equal(
    rpcFrameSchema.safeParse({ ...frame, fragmentCount: 65 }).success,
    false,
    "fragmentCount 上限 64",
  );
  assert.equal(
    rpcFrameSchema.safeParse({ ...frame, checksum: { algorithm: "crc32", value: "XYZ" } }).success,
    false,
  );
  assert.equal(isRawTransportCandidate(frame), true);
  assert.equal(isRawTransportCandidate({ zcode_type: "bootstrap-request", requestId: "1" }), false);
});

test("应用层消息 schema:判别联合与严格性", () => {
  const bootstrap = appMessageSchema.safeParse({ zcode_type: "bootstrap-request", requestId: "1" });
  assert.equal(bootstrap.success, true);
  assert.equal(
    appMessageSchema.safeParse({ zcode_type: "bootstrap-request", requestId: "1", extra: 1 }).success,
    false,
    "strict 对象拒绝多余字段",
  );
  assert.equal(appMessageSchema.safeParse({ zcode_type: "nope" }).success, false);
  const bridgeOpen = appMessageSchema.safeParse({
    zcode_type: "workspace-bridge-open",
    requestId: "r",
    bridgeSessionId: "b-1",
    workspaceKey: "/w",
  });
  assert.equal(bridgeOpen.success, true);
});

test("失败语义 11 reason 与横幅 key 全覆盖", () => {
  const keys = Object.keys(failureReasonI18nKeys);
  assert.equal(keys.length, 11);
  for (const key of keys) {
    assert.equal(failureReasonI18nKeys[key as keyof typeof failureReasonI18nKeys].startsWith("webRemoteControl.failure."), true);
  }
});

test("端点解析:env 覆盖优先,默认自建 relay", () => {
  assert.equal(resolveRelayWsUrl({}), "ws://127.0.0.1:37843/ws");
  assert.equal(
    resolveRelayWsUrl({ ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL: "wss://x/ws" }),
    "wss://x/ws",
  );
  assert.equal(
    resolveRemotePageUrl({ ZCODE_WEB_REMOTE_CONTROL_URL: "https://x/remote/v4" }),
    "https://x/remote/v4",
  );
});

test("定时数值锚定附录A(防回归漂移)", () => {
  assert.equal(WEB_REMOTE_CONTROL_LIMITS.heartbeatIntervalMs, 10_000);
  assert.equal(WEB_REMOTE_CONTROL_LIMITS.heartbeatAckTimeoutMs, 30_000);
  assert.equal(WEB_REMOTE_CONTROL_LIMITS.reconnectJitterMaxMs, 2_000);
  assert.equal(WEB_REMOTE_CONTROL_LIMITS.mobileDisconnectGraceMs, 3_000);
  assert.equal(WEB_REMOTE_CONTROL_LIMITS.startAuthTokenTtlMs, 30_000);
  assert.equal(WEB_REMOTE_CONTROL_LIMITS.outboundBufferMaxEntries, 50);
  assert.equal(WEB_REMOTE_CONTROL_LIMITS.rendererReconnectTimeoutMs, 120_000);
});

// 2026-09-26 真机排查补:hello 白名单放宽为忽略未知字段(防前向演进碎裂)。
test("parseMobileHelloFrame 忽略未知字段但保留必填校验", () => {
  const base={type:"mobile_hello",sid:" sid1 ",hash:" hash1 "};
  const parsed=parseMobileHelloFrame({...base,name:"phone",app_version:"1"});
  assert.ok(parsed);
  assert.equal(parsed.sid,"sid1");
  assert.equal(parsed.hash,"hash1");
  assert.equal(parseMobileHelloFrame({type:"mobile_hello",sid:"",hash:"h"}),null);
  assert.equal(parseMobileHelloFrame({type:"other",sid:"s",hash:"h"}),null);
  assert.equal(parseMobileHelloFrame(null),null);
});
