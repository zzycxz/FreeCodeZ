import { randomBytes } from "node:crypto";
import type { RelayDeviceMeta, RelayPairStatus } from "@zcode/shared/web-remote-control";

// 单终端配对表（附录A §1 relay 职责边界）：每个 device_sid 一条表项，
// 只保存 pass_hash 与设备/手机两个连接引用，不落任何业务状态（工作区/任务/会话都归桌面）。
// 本表是纯内存状态：踢旧（KICKED）与配对迁移只做判定并返回待处理列表，
// 报文发送与断开由 relayProtocol 层负责，避免状态层依赖线格式。

export type RelayRole = "device" | "mobile";

/** relay 侧连接句柄（WS 细节由 webRemoteRelayServer 注入）。 */
export interface RelayConn {
  readonly connId: string;
  readonly role: RelayRole;
  /** 发送已序列化的文本帧；连接不可用时返回 false。 */
  sendText(text: string): boolean;
  close(code: number, reason: string): void;
}

export interface PairingEntry {
  readonly deviceSid: string;
  deviceMid: string;
  passHash: string;
  meta?: RelayDeviceMeta;
  deviceConn?: RelayConn;
  mobileConn?: RelayConn;
  pairStatus: RelayPairStatus;
}

export type PairingKickReason = "device-replaced" | "mobile-replaced" | "pass-hash-rotated";

export interface PairingKick {
  conn: RelayConn;
  entry: PairingEntry;
  reason: PairingKickReason;
}

export interface RegisterDeviceInput {
  deviceMid: string;
  passHash: string;
  meta?: RelayDeviceMeta;
}

export interface RegisterDeviceResult {
  entry: PairingEntry;
  /** false = 同 mid 重注册，复用已有 sid 条目。 */
  created: boolean;
  /** pass_hash 变化（刷新二维码 rotate）→ 旧链接/旧手机立即失效。 */
  passHashRotated: boolean;
  kicked: PairingKick[];
}

export type AttachDeviceResult = { entry: PairingEntry; kicked: PairingKick[] } | null;

export type AttachMobileResult =
  | { ok: true; entry: PairingEntry; kicked: PairingKick[] }
  | { ok: false; reason: "unknown-sid" | "hash-mismatch" };

export interface DetachResult {
  entry: PairingEntry;
  /** 手机端断开（含被替换后的残留断开已由身份检查排除）。 */
  mobileDisconnected: boolean;
}

export class PairingTable {
  private readonly bySid = new Map<string, PairingEntry>();
  private readonly sidByMid = new Map<string, string>();
  private readonly entryByConn = new Map<RelayConn, PairingEntry>();

  /**
   * 设备注册：同 mid 重注册复用已有 sid 条目（pass_hash 更新）；
   * pass_hash 变化视为 rotate，踢掉现有手机并让配对回到 waiting。
   * 注册即认领设备槽：同 sid 的旧设备连接被 KICKED（单终端语义）。
   */
  registerDevice(input: RegisterDeviceInput, conn: RelayConn): RegisterDeviceResult {
    const kicked: PairingKick[] = [];
    const existingSid = this.sidByMid.get(input.deviceMid);
    const existing = existingSid ? this.bySid.get(existingSid) : undefined;
    if (existing) {
      const passHashRotated = existing.passHash !== input.passHash;
      existing.passHash = input.passHash;
      existing.meta = input.meta;
      if (passHashRotated && existing.mobileConn) {
        kicked.push({ conn: existing.mobileConn, entry: existing, reason: "pass-hash-rotated" });
        existing.mobileConn = undefined;
        existing.pairStatus = "waiting";
      }
      this.claimDeviceSlot(existing, conn, kicked);
      return { entry: existing, created: false, passHashRotated, kicked };
    }

    const entry: PairingEntry = {
      deviceSid: randomBytes(24).toString("base64url"),
      deviceMid: input.deviceMid,
      passHash: input.passHash,
      meta: input.meta,
      pairStatus: "waiting",
    };
    this.bySid.set(entry.deviceSid, entry);
    this.sidByMid.set(entry.deviceMid, entry.deviceSid);
    this.claimDeviceSlot(entry, conn, kicked);
    return { entry, created: true, passHashRotated: false, kicked };
  }

  /** 鉴权通过后认领设备槽（同 sid 第二连接 → 踢旧设备）。 */
  attachDevice(deviceSid: string, conn: RelayConn): AttachDeviceResult {
    const entry = this.bySid.get(deviceSid);
    if (!entry) {
      return null;
    }
    const kicked: PairingKick[] = [];
    this.claimDeviceSlot(entry, conn, kicked);
    return { entry, kicked };
  }

  /**
   * 手机端认领（凭链接里的 sid+hash，hash 须等于该 sid 注册的 pass_hash）：
   * 无前手机 → matched 双向可转发；有前手机 → 前手机被 KICKED 并替换。
   */
  attachMobile(deviceSid: string, passHash: string, conn: RelayConn): AttachMobileResult {
    const entry = this.bySid.get(deviceSid);
    if (!entry) {
      return { ok: false, reason: "unknown-sid" };
    }
    if (entry.passHash !== passHash) {
      return { ok: false, reason: "hash-mismatch" };
    }
    const kicked: PairingKick[] = [];
    if (entry.mobileConn && entry.mobileConn !== conn) {
      kicked.push({ conn: entry.mobileConn, entry, reason: "mobile-replaced" });
    }
    entry.mobileConn = conn;
    entry.pairStatus = "matched";
    this.entryByConn.set(conn, entry);
    return { ok: true, entry, kicked };
  }

  findBySid(deviceSid: string): PairingEntry | undefined {
    return this.bySid.get(deviceSid);
  }

  entryOf(conn: RelayConn): PairingEntry | undefined {
    return this.entryByConn.get(conn);
  }

  /** 连接断开：手机断开 → pairStatus 回 waiting（由调用方推送通知设备）。 */
  detach(conn: RelayConn): DetachResult | undefined {
    const entry = this.entryByConn.get(conn);
    if (!entry) {
      return undefined;
    }
    this.entryByConn.delete(conn);
    let mobileDisconnected = false;
    if (entry.deviceConn === conn) {
      entry.deviceConn = undefined;
    }
    // 身份检查：被替换端的残留 close 事件不得覆盖新连接的状态。
    if (entry.mobileConn === conn) {
      entry.mobileConn = undefined;
      mobileDisconnected = true;
      entry.pairStatus = "waiting";
    }
    return { entry, mobileDisconnected };
  }

  stats(): { entries: number; devices: number; mobiles: number } {
    let devices = 0;
    let mobiles = 0;
    for (const entry of this.bySid.values()) {
      if (entry.deviceConn) devices += 1;
      if (entry.mobileConn) mobiles += 1;
    }
    return { entries: this.bySid.size, devices, mobiles };
  }

  private claimDeviceSlot(entry: PairingEntry, conn: RelayConn, kicked: PairingKick[]): void {
    if (entry.deviceConn && entry.deviceConn !== conn) {
      kicked.push({ conn: entry.deviceConn, entry, reason: "device-replaced" });
    }
    entry.deviceConn = conn;
    this.entryByConn.set(conn, entry);
  }
}
