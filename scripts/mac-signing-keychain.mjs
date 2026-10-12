// 签名专用钥匙串解锁（2026-10-12 去密码改造配套）：
// fcz-sign 是签名专用钥匙串（~/Library/Keychains/fcz-sign.keychain-db），为空口令、
// 无自动锁定，只放 "FreeCodeZ Dev Signing" 自签证书私钥（证书备份见
// ~/Documents/freecodez-signing-backup/）。重启/注销后钥匙串处于锁定态，codesign
// 取私钥会弹 GUI 口令窗并让打包进程静默挂起；签名前用空口令非交互解锁即可全程
// 免点击（set-key-partition-list 已把 codesign 预授权进分区列表）。
// 失败不抛错：钥匙串可能已解锁、不存在（CI/无证书机器走 adhoc 兜底，无需解锁），
// 或被改回有口令（此时回落 GUI 人工输入，不阻断流程）。
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const SIGNING_KEYCHAIN_PATH = join(
  homedir(),
  "Library",
  "Keychains",
  "fcz-sign.keychain-db",
);

/**
 * 解锁签名专用钥匙串（幂等、尽力而为）。runSecurity 注入用（测试），
 * 缺省 spawnSync 原生 security。返回是否解锁成功。
 */
export function unlockSigningKeychain(runSecurity = defaultRunSecurity) {
  try {
    return runSecurity(["unlock-keychain", "-p", "", SIGNING_KEYCHAIN_PATH]);
  } catch {
    return false;
  }
}

function defaultRunSecurity(args) {
  const result = spawnSync("security", args, { encoding: "utf8" });
  return result.status === 0;
}
