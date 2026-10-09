// R20(2026-10-08 用户裁决「完全和 ZCode 独立」,解封 F.1 交叠):身份键 HELPER_BUNDLE_ID 一族改
// app.freecodez.*。依据:macOS TCC access 表主键 (service, client=**bundle id**, client_type)——
// 与 ZCode 共用 dev.zcode.cua-helper 时辅助功能/屏幕录制各只一行,后授权者顶写 csreq,对端掉授权。
// mac 自研线全链同源消费本常量(构建 Info.plist/identity.json、broker-server 安装验签期望、
// product-helper-host 接受集、helper-main 自报 authorization_subject/grant_owner),改此一处全链跟随。
// Windows vendored 线锚点在冻结的 helper-runtime/dist/windows-helper.js 内部自洽,与本常量零耦合(H.3-2 收窄)。
// 真契约串(ZCodeComputerUseIPC-1、管道前缀、ZCODE_CUA_* env 族)仍冻结不动。
export const HELPER_APP_NAME = "FreeCodeZ Computer Use.app";
export const DEV_HELPER_APP_NAME = "FreeCodeZ Computer Use Dev.app";
export const HELPER_DISPLAY_NAME = "FreeCodeZ Computer Use";
export const HELPER_BUNDLE_ID = "app.freecodez.cua-helper";
export const DEV_CUA_HELPER_BUNDLE_ID = "app.freecodez.cua-helper.dev";
// 入口脚本相对 .app 束根的布局（build 脚本落位/host 直接 spawn/open 形态三方共用；单源防漂移）。
// open 形态必须把它作为 --args 后首个参数传给可执行体（=node 底座），否则 node 把 --socket
// 当自身 CLI 选项报 bad option 即退（2026-10-08 真机实证）。
export const HELPER_ENTRY_RELATIVE_PATH = "Contents/Resources/dist/helper-main.mjs";
