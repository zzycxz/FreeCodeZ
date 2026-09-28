import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEmbeddedRelayEndpoints,
  embeddedRelayPortCandidates,
  pickLanIPv4,
} from "@zcode/shared/web-remote-control";

// spec web-remote-control §5 内嵌 LAN relay 的地址派生纯函数。

test("pickLanIPv4 按 192.168 > 172.16-31 > 10 > 其它排序且跳过 internal/非 IPv4", () => {
  const interfaces = [
    [
      { family: "IPv6", internal: false, address: "fe80::1" },
      { family: "IPv4", internal: true, address: "127.0.0.1" },
    ],
    [{ family: "IPv4", internal: false, address: "10.0.0.5" }],
    [{ family: "IPv4", internal: false, address: "172.20.1.9" }],
    [{ family: "IPv4", internal: false, address: "192.168.1.23" }],
  ];
  assert.equal(pickLanIPv4(interfaces), "192.168.1.23");
});

test("pickLanIPv4 同级保持接口枚举序（稳定），172 越界段不享受私网优先", () => {
  assert.equal(
    pickLanIPv4([
      [{ family: "IPv4", internal: false, address: "172.32.1.1" }],
      [{ family: "IPv4", internal: false, address: "10.1.1.1" }],
    ]),
    "10.1.1.1",
  );
  assert.equal(
    pickLanIPv4([
      [{ family: "IPv4", internal: false, address: "172.31.0.2" }],
      [{ family: "IPv4", internal: false, address: "172.16.0.2" }],
    ]),
    // 同段（172.16-31 都 rank 1）保持枚举序：首个出现的胜出。
    "172.31.0.2",
  );
  // 同级 10.x：首个出现者优先。
  assert.equal(
    pickLanIPv4([
      [{ family: "IPv4", internal: false, address: "10.2.2.2" }],
      [{ family: "IPv4", internal: false, address: "10.1.1.1" }],
    ]),
    "10.2.2.2",
  );
});

test("pickLanIPv4 无候选返回 null", () => {
  assert.equal(
    pickLanIPv4([[{ family: "IPv6", internal: false, address: "fd00::1" }]]),
    null,
  );
  assert.equal(pickLanIPv4([]), null);
});

test("embeddedRelayPortCandidates 默认 37843 起顺延 10 个", () => {
  const ports = embeddedRelayPortCandidates();
  assert.equal(ports.length, 10);
  assert.equal(ports[0], 37843);
  assert.equal(ports[9], 37852);
  assert.deepEqual(embeddedRelayPortCandidates(3, 40000), [40000, 40001, 40002]);
});

test("buildEmbeddedRelayEndpoints 桌面回环 WS + 手机 LAN 页基址", () => {
  assert.deepEqual(buildEmbeddedRelayEndpoints({ port: 37844, lanHost: "192.168.1.5" }), {
    wsUrl: "ws://127.0.0.1:37844/ws",
    pageBaseUrl: "http://192.168.1.5:37844/remote/v4",
  });
});
