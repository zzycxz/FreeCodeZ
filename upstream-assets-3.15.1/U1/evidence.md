# U1 批上游证据固化（ZCode 3.15.1）

来源：/Applications/ZCode.app（CFBundleShortVersionString=3.15.1，CFBundleVersion=3.15.1.8093）。
已验证：其 `app.asar`（340510048 字节）与 `glm/zcode.cjs`（sha256 见下）和 Downloads/ZCode-3.15.1-mac-arm64.dmg 内同路径文件 **cmp 逐字节一致**（2026-10-13 会话内验证）。

## SHA256SUMS

```
b816e38656e70fb585fe2ab1ea010da89cda928dac1ccb5d83255fd18796da6e  glm/zcode.cjs（3.15.1）
app.asar=340510048 bytes（与 DMG 一致；未做整包 sha256，以 cmp 等价为准）
```

## U1-1 上游实现（main/index.js@≈709424，minified 解码）

OpenExternal handler 的 file: 分支（函数 `zk`@≈655320 = fileURLToPath→normalize/realpath→`_p`=openPathInDefaultApp→shell.openPath，成功日志「本地文件打开成功」）；3.14.3 无此分支（fileURLToPath 在 3.14.3 main 中 0 次出现）。

FC 侧被删 handler 原文（git `8ccf9b9c~1:packages/desktop/src/main/desktopMainIpcRemote.ts` 第 309-311 行）：

```ts
ipcMain.handle(PlatformChannels.OpenExternalFile, async (_event, rawPath: string) =>
  openPathInDefaultApp(rawPath, options.logger),
);
```

## U1-2 上游实现（main/index.js@≈373022）

win32 defaultApp：`setAsDefaultProtocolClient(scheme, process.execPath, [entry, "--"])`；win32 packaged：`setAsDefaultProtocolClient(scheme, process.execPath, ["--"])`；非 win32 维持原注册形态。语义：Windows 协议激活把 URL 追加进命令行，尾部 `--` 使其后内容一律按位置参数处理，防参数注入。

## U1-3 上游实现（main/index.js@≈354716）

`resolveStartupAgentWarmupTargets` 截断常量 3→1；host 协议校验 `agentWarmupTargets: array(...).max(1)`（host/chunk-MR7X55B4.js@≈694832，3.14.3 为 .max(3)）。

## U1-4 上游实现（main/index.js@≈527158，applyEmbeddedBrowserPermissionPolicy）

- allowlist 自动放行：`clipboard-sanitized-write / fullscreen / pointerLock / mediaKeySystem`
- 可询问 13 项（本批不做询问，一律拒绝）：media/clipboard-read/geolocation/notifications/midi/midiSysex/idle-detection/speaker-selection/window-management/storage-access/top-level-storage-access/keyboardLock/fileSystem
- 设备（usb/hid/serial）走设备选择器（本批无选择器→拒绝）；其余 permission **default-deny**（logDecision source:"default-deny"）
- 修复背景：不装 handler 时 Electron 默认自动批准一切权限请求（官方 Security 文档明示）
