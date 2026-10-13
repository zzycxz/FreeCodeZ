// U1-4（移植自 ZCode 3.15.1）内置浏览器权限止血策略纯件测试：
// allowlist 四项自动放行；其余（摄像头/麦克风/定位/通知/设备）一律 default-deny——
// 修复前 embedded session 无任何 handler，Electron 默认自动批准一切权限请求。
import assert from "node:assert/strict";
import test from "node:test";
import { isEmbeddedBrowserPermissionAutoAllowed } from "../src/main/embeddedBrowserPermissionPolicy.js";

test("allowlist 四项自动放行（与上游 3.15.1 同集）", () => {
  const allowlist = ["clipboard-sanitized-write", "fullscreen", "pointerLock", "mediaKeySystem"];
  for (const permission of allowlist) {
    assert.equal(isEmbeddedBrowserPermissionAutoAllowed(permission), true, permission);
  }
});

test("allowlist 之外一律拒绝（隐私面与设备面）", () => {
  const denied = [
    "media",
    "geolocation",
    "notifications",
    "clipboard-read",
    "midi",
    "midiSysex",
    "idle-detection",
    "keyboardLock",
    "storage-access",
    "fileSystem",
    "usb",
    "hid",
    "serial",
  ];
  for (const permission of denied) {
    assert.equal(isEmbeddedBrowserPermissionAutoAllowed(permission), false, permission);
  }
});
