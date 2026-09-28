import test from "node:test";
import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import {
  isPrivateIpv4,
  isVirtualIface,
  listPairNicCandidates,
  nicLabel,
  parseRoutePrintWindows,
} from "../src/main/webRemoteControl/lanAddress.js";

// LAN 地址选取纯函数（spec web-remote-control §5，fairpeer 默认路由出口法的 TS 移植）。

function nic(
  family: "IPv4" | "IPv6",
  internal: boolean,
  address: string,
): NetworkInterfaceInfo {
  return {
    family,
    internal,
    address,
    netmask: family === "IPv4" ? "255.255.255.0" : "ffff:ffff::",
    mac: "00:00:00:00:00:00",
    scopeid: family === "IPv6" ? 1 : undefined,
    cidr: family === "IPv4" ? `${address}/24` : undefined,
  };
}

test("isPrivateIpv4：10/172.16-31/192.168 私网为真，回环/链路本地/公网为假", () => {
  assert.equal(isPrivateIpv4("192.168.1.5"), true);
  assert.equal(isPrivateIpv4("10.0.0.2"), true);
  assert.equal(isPrivateIpv4("172.20.1.1"), true);
  assert.equal(isPrivateIpv4("172.32.0.1"), false);
  assert.equal(isPrivateIpv4("127.0.0.1"), false);
  assert.equal(isPrivateIpv4("169.254.1.1"), false);
  assert.equal(isPrivateIpv4("8.8.8.8"), false);
  assert.equal(isPrivateIpv4("198.18.0.1"), false); // TUN fake-ip 段非私网
  assert.equal(isPrivateIpv4("not-an-ip"), false);
});

test("isVirtualIface：vmware/clash/tun/wsl/hyper-v/tailscale 等命中，以太网/WLAN 不命中", () => {
  assert.equal(isVirtualIface("VMware Network Adapter VMnet1"), true);
  assert.equal(isVirtualIface("vEthernet (Hyper-V)"), true);
  assert.equal(isVirtualIface("Meta"), true);
  assert.equal(isVirtualIface("TAP-Windows Adapter"), true);
  assert.equal(isVirtualIface("WSL"), true);
  assert.equal(isVirtualIface("Tailscale"), true);
  assert.equal(isVirtualIface("以太网"), false);
  assert.equal(isVirtualIface("WLAN"), false);
  assert.equal(isVirtualIface("Ethernet"), false);
});

test("nicLabel：Wi-Fi/有线/局域网 友好标签", () => {
  assert.equal(nicLabel("WLAN"), "Wi-Fi");
  assert.equal(nicLabel("Wi-Fi 2"), "Wi-Fi");
  assert.equal(nicLabel("以太网"), "有线");
  assert.equal(nicLabel("Ethernet 3"), "有线");
  assert.equal(nicLabel("Random"), "局域网");
});

test("listPairNicCandidates：跳过 internal/IPv6/非私网/虚拟网卡，去重，.1 网关位垫底，默认项带理由", () => {
  const candidates = listPairNicCandidates(
    {
      WLAN: [nic("IPv4", false, "192.168.1.23")],
      以太网: [nic("IPv4", false, "10.0.0.8")],
      "VMware Network Adapter VMnet1": [nic("IPv4", false, "192.168.152.1")],
      "vEthernet (Hyper-V)": [nic("IPv4", false, "172.30.1.1")],
      Loopback: [nic("IPv4", true, "127.0.0.1")],
      Tunnel: [nic("IPv6", false, "fe80::1")],
      WLAN2: [nic("IPv4", false, "192.168.1.23")], // 重复 IP 去重
      "Gateway-ish": [nic("IPv4", false, "10.0.0.1")], // .1 垫底
    },
    "192.168.1.23",
    "默认路由出口（route 表 metric 最低）",
  );
  assert.deepEqual(
    candidates.map((entry) => entry.ip),
    ["192.168.1.23", "10.0.0.8", "10.0.0.1"],
  );
  const [first] = candidates;
  assert.equal(first.isDefault, true);
  assert.equal(first.reason, "默认路由出口（route 表 metric 最低）");
  assert.equal(candidates[1].isDefault, false);
  assert.equal(candidates[1].reason, undefined);
});

test("parseRoutePrintWindows：按位置取 0.0.0.0/0，metric 升序，排除非私网出口与 /1 劫持路由，去重", () => {
  const output = [
    "===========================================================================",
    "Interface List",
    " 17...00 15 5d 00 00 00 ......Hyper-V Virtual Ethernet Adapter",
    "===========================================================================",
    "Active Routes:",
    "Network Destination        Netmask          Gateway       Interface  Metric",
    "          0.0.0.0          0.0.0.0     192.168.1.254   192.168.1.23     25",
    "          0.0.0.0          0.0.0.0      10.0.0.254      10.0.0.8     50",
    "          0.0.0.0        128.0.0.0     198.18.0.1     198.18.0.2      1", // Clash /1 劫持（掩码非 0.0.0.0）
    "          0.0.0.0          0.0.0.0     172.16.0.254  172.16.5.5     10", // metric 更低，应排最前
    "        127.0.0.0        255.0.0.0         On-link       127.0.0.1    331",
    "          0.0.0.0          0.0.0.0     192.168.1.254   192.168.1.23     25", // 重复
  ].join("\r\n");
  const entries = parseRoutePrintWindows(output);
  assert.deepEqual(
    entries.map((entry) => [entry.ip, entry.metric]),
    [["172.16.5.5", 10], ["192.168.1.23", 25], ["10.0.0.8", 50]],
  );
});

test("parseRoutePrintWindows：TUN fake-ip 出口（非私网）被排除，全劫持时返回空", () => {
  const output =
    "          0.0.0.0          0.0.0.0     198.18.0.1     198.18.0.2      1";
  assert.deepEqual(parseRoutePrintWindows(output), []);
});
