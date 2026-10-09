# @zcode/zcode-cua

FreeCodeZ 的 Computer Use 执行栈（原 ZCode 占位包的 B2 真实现 + R19 mac Helper 产线）：
- 协议面：NDJSON broker（42+2 方法，`ZCodeComputerUseIPC-1`）客户端/服务端分发与固定 socket 命名；
- mac 执行层：koffi FFI（AX 观察/动作）进程内路线 + `FreeCodeZ Computer Use.app` Helper 产线（`macos/helper-main.js`）；
- 宿主生命周期：安装/验签/spawn/健康对账（`macos/product-helper-host.js`，darwin 真实现，他平台 fail-closed）。
`.d.ts` 契约面与官方包逐符号兼容；Windows 执行面走 vendored helper runtime（见 spec §2）。
