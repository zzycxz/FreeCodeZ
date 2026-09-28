import { execFile } from "node:child_process";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { promisify } from "node:util";
import { pickLanIPv4 } from "@zcode/shared/web-remote-control";

// LAN 地址选取（spec web-remote-control §5，借鉴 fairpeer linkpeer 的默认路由出口法）：
// 钉选（settings）> 默认路由出口（win32 route print / UDP 路由决策）> 网卡枚举排序（pickLanIPv4）。
// 本模块不依赖 electron；探测函数均可注入，纯函数部分（route 表解析/候选列表）单测覆盖。

const execFileAsync = promisify(execFile);

/** 虚拟网卡关键字（小写包含匹配；中文系统友好名如「以太网/WLAN」不命中）。 */
const VIRTUAL_IFACE_KEYWORDS = [
  "meta",
  "clash",
  "mihomo",
  "singbox",
  "sing-box",
  "tun",
  "tap",
  "vmware",
  "vmnet",
  "virtualbox",
  "wsl",
  "hyper-v",
  "vethernet",
  "loopback",
  "zerotier",
  "tailscale",
  "wireguard",
  "openvpn",
  "vpn",
  "docker",
  "veth",
];

export function isVirtualIface(name: string): boolean {
  const lowered = name.toLowerCase();
  return VIRTUAL_IFACE_KEYWORDS.some((keyword) => lowered.includes(keyword));
}

/** 私网 IPv4 判定（10/8、172.16/12、192.168/16）；排除回环与链路本地。 */
export function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const a = Number.parseInt(parts[0] ?? "", 10);
  const b = Number.parseInt(parts[1] ?? "", 10);
  const c = Number.parseInt(parts[2] ?? "", 10);
  const d = Number.parseInt(parts[3] ?? "", 10);
  if ([a, b, c, d].some((octet) => Number.isNaN(octet) || octet > 255)) return false;
  if (a === 127 || a === 169) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

export interface LanNicCandidate {
  ip: string;
  name: string;
  /** 友好标签：有线 / Wi-Fi / 局域网。 */
  label: string;
  isDefault: boolean;
  /** 默认判定理由（仅默认项有值，UI 展示用）。 */
  reason?: string;
}

export function nicLabel(name: string): string {
  const lowered = name.toLowerCase();
  if (lowered.includes("wlan") || lowered.includes("wi-fi") || lowered.includes("wifi")) {
    return "Wi-Fi";
  }
  if (lowered.includes("ethernet") || name.includes("以太网")) return "有线";
  return "局域网";
}

/**
 * 候选网卡列表：真实网卡（跳过 down/回环/链路本地/非私网/虚拟网卡），按 IP 去重；
 * x.x.x.1 网关位地址（虚拟网卡常见形态）垫底；默认项 = 出口 IP（调用方传入判定结果）。
 */
export function listPairNicCandidates(
  interfaces: Readonly<Record<string, NetworkInterfaceInfo[] | undefined>>,
  egressIp: string | null,
  egressReason?: string,
): LanNicCandidate[] {
  const head: LanNicCandidate[] = [];
  const tail: LanNicCandidate[] = [];
  const seen = new Set<string>();
  for (const [name, list] of Object.entries(interfaces)) {
    for (const info of list ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      if (!isPrivateIpv4(info.address) || seen.has(info.address)) continue;
      if (isVirtualIface(name)) continue;
      seen.add(info.address);
      const candidate: LanNicCandidate = {
        ip: info.address,
        name,
        label: nicLabel(name),
        isDefault: info.address === egressIp,
        ...(info.address === egressIp && egressReason ? { reason: egressReason } : {}),
      };
      if (info.address.endsWith(".1")) tail.push(candidate);
      else head.push(candidate);
    }
  }
  return [...head, ...tail];
}

/** win32 候选（含虚拟网卡过滤前的完整列表口径差异：列表也过滤虚拟网卡，与 fairpeer 一致）。 */
export function listPairNics(egressIp: string | null, egressReason?: string): LanNicCandidate[] {
  return listPairNicCandidates(networkInterfaces(), egressIp, egressReason);
}

interface DefaultRouteEntry {
  ip: string;
  metric: number;
}

/**
 * 解析 `route print -4` 输出：收集 0.0.0.0/0 默认路由（按字段位置解析，兼容中英文表头）；
 * 掩码非 0.0.0.0 的 /1 劫持路由（Clash 128.0.0.0）与 TUN fake-ip 非私网出口天然被排除；
 * metric 升序、按 ip/metric 去重。纯函数。
 */
export function parseRoutePrintWindows(output: string): DefaultRouteEntry[] {
  const entries: DefaultRouteEntry[] = [];
  const seen = new Set<string>();
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const [dest, mask, gateway, ipField, metricField] = fields;
    if (dest !== "0.0.0.0" || mask !== "0.0.0.0" || !ipField || !metricField) continue;
    if (!isPrivateIpv4(ipField)) continue;
    const metric = Number.parseInt(metricField, 10);
    if (Number.isNaN(metric)) continue;
    void gateway;
    const key = `${ipField}/${metric}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ ip: ipField, metric });
  }
  entries.sort((left, right) => left.metric - right.metric);
  return entries;
}

/**
 * 默认路由出口 IP（win32）：`route print -4` 解析 metric 最低的默认路由。
 * 800ms 超时、windowsHide（GUI 父进程无控制台，不隐藏会闪 CMD 窗）；失败返回 null 降级。
 */
async function windowsDefaultRouteEgress(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("route", ["print", "-4"], {
      timeout: 800,
      windowsHide: true,
    });
    const entries = parseRoutePrintWindows(stdout);
    return entries[0]?.ip ?? null;
  } catch {
    return null;
  }
}

/**
 * UDP「连接」探测出口 IP：不发任何数据包，只让内核做路由决策后读本端地址。
 * 结果必须私网——公网出口说明被代理 TUN 劫持（fake-ip / 全局代理），拒收。
 */
async function udpEgressProbe(): Promise<string | null> {
  const { createSocket } = await import("node:dgram");
  return new Promise((resolve) => {
    let socket;
    try {
      socket = createSocket("udp4");
    } catch {
      resolve(null);
      return;
    }
    const finish = (ip: string | null) => {
      try {
        socket.close();
      } catch {
        /* 已关闭 */
      }
      resolve(ip);
    };
    socket.once("error", () => finish(null));
    try {
      socket.connect(80, "8.8.8.8", () => {
        const address = socket.address();
        finish(typeof address === "object" && isPrivateIpv4(address.address) ? address.address : null);
      });
    } catch {
      finish(null);
    }
  });
}

/**
 * 解析自动模式的 LAN 出口 IP（钉选逻辑在调用方）：默认路由出口 > UDP 探测 > 网卡枚举排序。
 * 附带判定理由（UI 展示"为什么是它"）。
 */
export async function resolveDefaultLanHost(): Promise<{ ip: string; reason: string } | null> {
  if (process.platform === "win32") {
    const routeIp = await windowsDefaultRouteEgress();
    if (routeIp) return { ip: routeIp, reason: "默认路由出口（route 表 metric 最低）" };
  }
  const udpIp = await udpEgressProbe();
  if (udpIp) return { ip: udpIp, reason: "默认路由出口（UDP 探测）" };
  const fallback = pickLanIPv4(Object.values(networkInterfaces()).map((list) => list ?? []));
  return fallback ? { ip: fallback, reason: "物理网卡（枚举回退）" } : null;
}
