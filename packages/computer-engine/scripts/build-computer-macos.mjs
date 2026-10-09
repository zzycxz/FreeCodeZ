#!/usr/bin/env node
// FreeCodeZ helper 装配脚本（W-11；参考 orca config/scripts/build-computer-macos.mjs 重写，
// orca 为 MIT 派生参考件，本件为 FreeCodeZ 自有实现）。
// 产物：packages/computer-engine/native/computer-use-macos/.build/release/FreeCodeZ Computer Use.app
// 身份：bundle id app.freecodez.computer-use（R20 族），LSUIElement + 双 usage description 保留。
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const pkgRoot = path.resolve(import.meta.dirname, "..");
const packagePath = path.join(pkgRoot, "native", "computer-use-macos");
const binaryPath = path.join(packagePath, ".build", "release", "freecodez-computer-use-macos");
const appPath = path.join(packagePath, ".build", "release", "FreeCodeZ Computer Use.app");
const appExecutablePath = path.join(appPath, "Contents", "MacOS", "freecodez-computer-use-macos");
const entitlementsPath = path.join(pkgRoot, "native", "resources", "entitlements.computer-use.mac.plist");
const bundleId = process.env.FREECODEZ_COMPUTER_MACOS_BUNDLE_ID ?? "app.freecodez.computer-use";
const displayName = "FreeCodeZ Computer Use";
const signingIdentity = resolveSigningIdentity();
const universalTriples = ["arm64-apple-macosx", "x86_64-apple-macosx"];

if (process.platform !== "darwin") {
  console.log("[build-computer-macos] skip: darwin only");
  process.exit(0);
}

buildUniversalBinary();
chmodSync(binaryPath, 0o755);
createHelperApp();

function buildUniversalBinary() {
  const builtBinaries = universalTriples.map((triple) => {
    run("swift", ["build", "-c", "release", "--package-path", packagePath, "--triple", triple]);
    return path.join(packagePath, ".build", triple, "release", "freecodez-computer-use-macos");
  });
  mkdirSync(path.dirname(binaryPath), { recursive: true });
  run("lipo", ["-create", ...builtBinaries, "-output", binaryPath]);
}

function createHelperApp() {
  rmSync(appPath, { recursive: true, force: true });
  mkdirSync(path.dirname(appExecutablePath), { recursive: true });
  mkdirSync(path.join(appPath, "Contents", "Resources"), { recursive: true });
  copyFileSync(binaryPath, appExecutablePath);
  chmodSync(appExecutablePath, 0o755);
  writeFileSync(path.join(appPath, "Contents", "Info.plist"), infoPlist(), "utf8");
  const signer = spawnSync("codesign", codesignArgs(signingIdentity, appPath), { stdio: "inherit" });
  if (signer.signal) {
    process.kill(process.pid, signer.signal);
  }
  if (signer.status !== 0) {
    process.exit(signer.status ?? 1);
  }
  console.log(`[build-computer-macos] built: ${appPath}`);
}

function codesignArgs(identity, targetPath) {
  const args = ["--force", "--deep", "--sign", identity];
  // 发布签名才上 hardened runtime + 时间戳（R19 口径）；adhoc/开发签名不加，保持本地可跑。
  if (process.env.FREECODEZ_MAC_RELEASE === "1" && identity !== "-") {
    args.push("--options", "runtime", "--timestamp", "--entitlements", entitlementsPath);
  }
  args.push(targetPath);
  return args;
}

function resolveSigningIdentity() {
  const explicitIdentity =
    process.env.FREECODEZ_COMPUTER_MACOS_SIGN_IDENTITY ?? process.env.CSC_NAME;
  if (explicitIdentity) {
    return explicitIdentity;
  }
  const identities = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });
  if (identities.status !== 0 || !identities.stdout) {
    return "-";
  }
  const developmentMatch = identities.stdout.match(/"([^"]*Apple Development:[^"]+)"/);
  if (process.env.FREECODEZ_MAC_RELEASE !== "1" && developmentMatch) {
    return developmentMatch[1];
  }
  const releaseMatch =
    identities.stdout.match(/"([^"]*Developer ID Application:[^"]+)"/) ??
    identities.stdout.match(/"([^"]*Apple Distribution:[^"]+)"/);
  return releaseMatch?.[1] ?? developmentMatch?.[1] ?? "-";
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>freecodez-computer-use-macos</string>
  <key>CFBundleIdentifier</key>
  <string>${escapePlist(bundleId)}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${escapePlist(displayName)}</string>
  <key>CFBundleDisplayName</key>
  <string>${escapePlist(displayName)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAccessibilityUsageDescription</key>
  <string>FreeCodeZ Computer Use needs Accessibility permission to read and interact with app interfaces when you ask FreeCodeZ to use apps.</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>FreeCodeZ Computer Use needs Screen Recording permission to capture app windows when you ask FreeCodeZ to inspect your screen.</string>
</dict>
</plist>
`;
}

function escapePlist(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
