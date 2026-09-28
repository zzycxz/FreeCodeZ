import { createHash, createHmac, randomBytes } from "node:crypto";

// relay challenge-response 鉴权工具（附录A §1，Node 专用 —— 仅 desktop main 与 relay 服务端引用）。
// 口令从不上传：password 仅本地持有，passHash 上行注册，proof 响应挑战。

export const CREDENTIAL_KEY_RELAY_PASS_HASH = "web-remote-control:external-relay:pass_hash";

/** password = randomBytes(24).base64url */
export function generateRelayPassword(): string {
  return randomBytes(24).toString("base64url");
}

/** passHash = sha256(pw).base64（标准 base64，非 base64url，与官方一致） */
export function hashRelayPassword(password: string): string {
  return createHash("sha256").update(password).digest("base64");
}

/** proof = base64url(HMAC-SHA256(passHash, `${nonce}|device|${deviceSid}`)) */
export function buildRelayAuthProof(
  passHash: string,
  nonce: string,
  deviceSid: string,
): string {
  return createHmac("sha256", passHash)
    .update(`${nonce}|device|${deviceSid}`)
    .digest("base64url");
}

export function verifyRelayAuthProof(
  passHash: string,
  nonce: string,
  deviceSid: string,
  proof: string,
): boolean {
  const expected = buildRelayAuthProof(passHash, nonce, deviceSid);
  if (expected.length !== proof.length) return false;
  // 定长比较，避免时序侧信道
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ proof.charCodeAt(i);
  }
  return diff === 0;
}

/** 设备 mid：稳定匿名设备标识（无 PII）。 */
export function generateDeviceMid(): string {
  return randomBytes(16).toString("hex");
}
