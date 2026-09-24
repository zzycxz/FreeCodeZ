import type { ZCodeTaskClientMode } from "@zcode/shared";

/**
 * 链路身份推导（上游 3.14.1 修复①的规则面，R6）：跨链路调用的 clientMode/deliveryKind
 * 一律按真实链路推导，禁止写死 desktop-continuous——手机远控/网页链路（web-remote-replayable）
 * 上写死 continuous 与真实链路不符时，host 的引用解析不会回 ready，草稿引用插不进去。
 */
export type ClientLinkMode = ZCodeTaskClientMode;

export interface ClientLinkIdentity {
  clientMode: ClientLinkMode;
  deliveryKind: ClientLinkMode;
}

/** 与上游 i_t(e) 同形推导：isWebRemote ? web-remote-replayable : desktop-continuous，两字段同值。 */
export function deriveClientLinkIdentity(isWebRemote: boolean): ClientLinkIdentity {
  const mode: ClientLinkMode = isWebRemote ? "web-remote-replayable" : "desktop-continuous";
  return { clientMode: mode, deliveryKind: mode };
}

// 当前壳链路身份的唯一事实源：hello 由 host 按 attachment 下发（渲染层不可伪造，
// 见 zcodeAgentConnectionScope 的可信连接注释），握手成功即采纳。服务端按通道定身份
// （普通 /ws=web-remote-replayable、可信 host 通道=desktop-continuous），同一壳内
// 所有 attachment 一致，故此处为壳级投影；默认 desktop-continuous，web 壳在首次
// 握手后自动纠正。写入口仅 agentV4ConnectionHandshake。
let currentClientLinkMode: ClientLinkMode = "desktop-continuous";

export function adoptClientLinkMode(mode: ClientLinkMode): void {
  currentClientLinkMode = mode;
}

export function currentClientLinkIdentity(): ClientLinkIdentity {
  return deriveClientLinkIdentity(currentClientLinkMode === "web-remote-replayable");
}
