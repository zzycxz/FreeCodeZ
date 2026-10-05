# FreeCodeZ vs OpenAI Codex 桌面应用（ChatGPT.app）全面清查报告

- 清查对象：`/Applications/ChatGPT.app`（实为 **OpenAI Codex 桌面应用**，bundle ID `com.openai.codex`，版本 26.928.21956 / build 12404，Codex CLI 0.159.2）
- 清查日期：2026-09-30
- 方法：asar 全量解包（产物在 `~/Desktop/swarm-os/codex-app-analysis/app`，538MB）+ 插件/运行时目录明文清查 + 二进制 strings + entitlements + 本机 `~/.codex` 运行时状态
- 原则：以效果为标尺（参照 gap-analysis-effect-based），不照抄机制

---

## 1. 身份与总体架构

壳是**深度改名的 Electron 42.3**（`Codex Framework.framework` = Chromium 154.0.8037.57），但真实架构是五层：

```
ChatGPT.app (Electron 主进程)
 ├─ 渲染层 webview（React 双入口，与 chatgpt.com Web 同仓构建）
 ├─ git-worker（worker_threads 线程：worktree/快照/PR 创建合并/watch）
 ├─ node-pty 终端（本地 / WSL / SSH 远程 / voice-work-terminal）
 ├─ 内嵌浏览器子系统（完整 Chromium profile + 侧栏 + 扩展 + WebMCP/CDP）
 │    └─ codex-code-mode-host（Rust+V8，protobuf/gRPC，受限 JS 执行）
 ├─ codex app-server（Rust 二进制 0.159.2，JSON-RPC over stdio/Unix socket/ws）
 │    ├─ 沙箱：macOS Seatbelt / Linux Landlock / Windows sandbox service
 │    ├─ MCP 客户端全协议（elicitation/completions/resources subscribe）
 │    ├─ SQLite 状态层（goals/threads/attachments/dynamic_tools/sections）
 │    └─ 定制 zsh 5.9 + ripgrep（hermetic PATH）
 ├─ cua_node（定制 Node 24.21.0-cua.1，271MB）
 │    ├─ node_repl（Rust+V8 沙箱 JS 内核，MCP stdio server）
 │    ├─ @oai/sky（96MB 原生 Computer Use 服务：SkyComputerUseService）
 │    ├─ @oai/cua + @oai/browser-desktop + playwright + sharp
 │    └─ voice（Rust voice-host + GStreamer + Opus + WebRTC 全栈）
 └─ plugins/openai-bundled（12 插件）+ ~/.cache/codex-runtimes（可下载 primary-runtime）
```

云侧另有 **Aeon**（durable 云执行后端/云侧对话，内部代号）与连接器生态（88 个应用图标）。

## 2. 分层组件全量清单

### 2.1 壳层（macOS 集成）

- **entitlements**：非 App Sandbox；APNs 生产推送；与 CUAService 共享 App Group；Apple Events 自动化；麦克风/摄像头/日历/提醒/用户选定文件读写；keychain 共享组；JIT 允许
- **URL Scheme**：`codex://` 深链 + **http/https 注册（可设为默认浏览器）**
- **权限声明**：日历/提醒事项读写（"read and update your calendar events"）、位置、桌面文件夹、音频采集
- **窗口形态**（6+ 种）：primary / quickChat 全局热键浮窗 / detached 独立窗口（带 prewarm 池与 phase 状态机）/ avatarOverlay 虚拟宠物透明置顶窗 / page（浏览器 tab）/ overlay / 1×1 截图引导窗 / app-server 慢启动进度窗
- **原生模块 13 个**：airpods-mute、bare-modifier-monitor（修饰键监听）、browser-use-peer-authorization、devicecheck（设备完整性证明）、hid-topology-watcher、input-monitoring-permission、launch-services-helper、remote-control-device-key、remote-hosted-pip（远程画中画）、sky、sparkle、system-audio-spectrum（24 段音频频谱流）、usb_webauthn
- **硬件**：Work Louder device-kit + `findCodexMicroInterfaces()` → **Codex Micro 硬件外设**（`CODEX_MICRO_LAYOUT`/`CODEX_MICRO_AGENT_SOURCE`）
- Sparkle 自动更新（EdDSA 签名 appcast）+ dock tile 插件

### 2.2 主进程（Electron）

- **IPC 面极薄**（24 个 `codex_desktop:` 通道），功能走 `connect-app-host` 之上的 chunked 流式 RPC + worker MessageChannel——与 FreeCodeZ"一功能一协议命令"不同，值得注意的架构取向
- **自定义协议**：`codex://`（应用资源）、`codex-sandbox://`（MCP 应用网页沙箱，限定 `web-sandbox.oaiusercontent.com`）、`codex-browser-sidebar://`、`app://`
- **文件关联**：csv/tsv/xls/xlsx/xlsm/docx/pptx + **`.skill` 文件类型**（`application/vnd.openai.codex.skill`，可双击安装技能）
- **Chromium 开关**：强制启用 **WebMCP** + DevTools WebMCP 支持
- **LSP 运行时自安装**：kotlin-server / rust-analyzer / astral-sh ty（Python 类型检查）
- **devbox-vnc**：SSH 隧道上的远程开发盒 VNC
- **tpp-local-executor**：第三方插件本地执行器
- **遥测三通道**：Sentry（DSN 内嵌）+ OTel（`chat.openai.com/ces/v1/telemetry/intake`）+ Statsig A/B
- **运维面**：任务管理器、性能 trace 录制→gzip→上传、系统状态页入口、企业 workspace policy 恢复流、Intel/Rosetta 警告
- **菜单功能**（zh-CN 209 键全枚举）：新聊天/临时聊天/聊天搜索 1-9/归档/重命名/置顶、听写、mini overlay、变更面板（review）、终端、文件树、浏览器 tab/地址栏/前进后退、复制深链/会话 ID/工作目录、命令面板、快捷键表

### 2.3 Agent 核心（codex 0.159.2，Rust，开源仓可对照）

- `codex app-server` 守护进程（Unix socket 控制、`daemon version` 探测、热重启、WSL 支持、SSH 远程管理 bootstrap）
- 协议版本门槛 `0.154.0-alpha.1`；启动参数 `--analytics-default-enabled`、Windows 专属 `features.code_mode_host=true` / `windows_sandbox_service`
- **OS 沙箱三平台**：Seatbelt（macOS）/ Landlock（Linux，现行实为 bwrap+seccomp）/ Windows sandbox service（WFP+MSIX+ACL），含 capability discovery 沙箱。**2026-10-03 修正**：此项不再是 FreeCodeZ 空白——FC 能力提升 E 批已落地自研三平台沙箱（macOS seatbelt 真机校准 / Linux bwrap / Windows 低完整级 MIC），技术栈不同但能力同级；差距收敛为 hardening 项（见终版对比"全记录对照修正"）
- 内嵌 **Starlark 解释器**（策略/配置脚本）
- **code-mode-host**（65MB，Rust+V8）：code-mode 会话/cell 模型、资源限额、yield 控制、HTTP/2 gRPC + stdio 双传输；暴露 setTimeout/Atomics/WebAssembly，禁止顶层静态 import——**给模型的受限 JS 执行环境**
- 模型目录：gpt-5.5 / gpt-5.6-luna / gpt-5.6-terra / **gpt-6-luna（当前默认）** / codex-auto-review / gpt-reserve
- 桌面集成诊断：`codex doctor` 检查 XProtect/Gatekeeper

### 2.4 CUA 栈（cua_node）

- **node_repl**（Rust+V8 MCP server）：沙箱 JS 内核（`NODE_REPL_DENIED_PATHS`、网络隔离、Unix socket 白名单、cell 超时重置）；JS API 有 config 读写、fetch、emitImage/emitAudio、**elicitation 表单**、`nodeRepl.rpc("sky")` 受信 RPC
- **@oai/sky**：`Codex Computer Use.app`（96MB，LSUIElement 后台服务 + Sparkle 自更新 + Protobuf IPC）——AX API 截屏/点击/键盘、Appshot 截图、授权插件（辅助功能/屏幕录制引导）、锁屏守护（CUALockScreenGuardian）、normal/relaxed 两档授权强度
- **一份原生二进制多 MCP 人格**：SkyComputerUseClient 以 `messages` / `computer-history` / `event-stream` 子命令挂成三个 MCP server
- **@oai/cua** 门面：initialize() 装配 computer + browsers + documentation

### 2.5 浏览器子系统（最大功能面之一）

- 完整 Chromium profile（Cookies/Local Storage/Safe Browsing/Crowd Deny/OnDeviceHeadSuggest——就是个真浏览器）
- 地址栏建议、站点设置子页、清除浏览数据对话框、账号切换器、浏览器扩展安装流
- **双产品**：`browser` 插件（in-app 隔离浏览器）与 `chrome` 插件（接管用户真 Chrome）——99% 同代码，靠 skill/图标差异化
- **Chrome Native Messaging 宿主**（原生 Mach-O `ChatGPT for Chrome`）+ 多浏览器矩阵安装器（Chrome/Edge/Brave/Opera/Vivaldi × darwin/linux/win32，含注册表键、CWS 扩展 ID 三渠道）
- 能力分级：`full_cdp_access_enabled`、`webmcp_enabled`、下载/上传/历史各自 approval_mode
- a11y WASM（4MB brotli）、QR 码读取 WASM、classic-level 会话存储
- 文档体系：23 篇运维文档 + **documents.json 按工具门控文档加载**（cdp/webmcp 工具强制绑定安全文档）

### 2.6 插件体系（12 个内置 + 双分发通道）

四种形态：MCP server 型 / 纯技能包 / 宿主运行时挂载型 / 同码双产品。

| 插件 | 形态 | 要点 |
|---|---|---|
| messages | MCP | 读发 macOS 原生信息 app |
| computer-history | MCP | 本地滚动活动事件流+记忆摘要（"你最近在干什么"） |
| record-and-replay | MCP | 录屏转可复用 Skill（≤30min，点击/输入/窗口内容） |
| computer-use | 纯技能 | 控制 Mac 应用 UI（能力来自宿主 sky） |
| unified-computer-use | 隐形基础设施 | 挂 cua_repl（js/js_reset/turn_ended） |
| browser / chrome | 宿主挂载 | 见 2.5 |
| code-review | MCP（2.4MB server.mjs + Web UI） | GitHub PR 全流程：本地无 checkout 审查、ChatGPT 代写 review、merge、checks、inbox |
| codex-app-tools | MCP 管道桥 | 桌面 app 工具（建线程/发消息/fork/handoff），**按工具粒度 approval_mode: prompt** |
| latex | 纯技能 | Tectonic 优先 + 托管 TeX Live 安装到 `~/.cache/codex-runtimes` |
| deep-research | 纯技能+agent 界面 | 多轮取证→引用 DOCX 报告，可隐式调用 |
| visualize | 纯技能+agent 界面 | 图表/地图/3D/数据浏览器，自带 HTML 运行时 shell |

机制要点：
- **hooks = 把会话生命周期事件（Interrupt/Stop/SubagentStop）转发给 MCP 工具调用**（模板变量 session_id/agent_id/turn_id），非 shell 执行
- **agents/openai.yaml**：把 skill 升级为带界面（display_name/icon/brand_color/default_prompt）可隐式调用的 agent 入口
- 插件市场：本地 marketplace.json（policy.installation=AVAILABLE、authentication=ON_INSTALL）+ **`~/.cache/codex-runtimes/codex-primary-runtime` 可下载运行时通道**
- `.mcp.json` 支持 `enabled_tools` / `omit_tools_from: [code_mode, deferred]`（按上下文裁剪工具面）、`default_tools_approval_mode`

### 2.7 语音

- Rust `codex-voice-host`：GStreamer 采集/播放 + Opus + 完整 WebRTC（ICE/STUN/TURN/DTLS/SRTP），模型在服务端
- 渲染层：silero-vad ONNX WASM（CDN）、实时音频 worklet、RTP transform worker、听写、语音信箱（voicemail）
- 8 个语音角色音效（arbor/breeze/cove/juniper/maple/sol/spruce/vale）
- system-audio-spectrum 频谱可视化 + airpods-mute 联动

### 2.8 渲染层（与 ChatGPT Web 同仓）

双入口（index + detached-window）React + Vite/Rolldown + Tailwind v4；19,087 assets（14,485 js chunk + 2,341 svg + 246 locale chunk + 31 .NET wasm）。

确认的功能表面：工作区主页（席位计费/用量）、**Codex Micro 迷你窗（摇杆 HUD/键盘面/小游戏）**、内嵌浏览器（654 文件）、画布/数学块/素描/图像编辑、**artifact 套件（docx 预览/表格编辑器/幻灯片/评论/批注/PDF）**、语音/实时对话、智能体任务（653 处"任务"）、连接器（88 应用）、深度研究、学习模式、购物、**虚拟宠物 Orbit（avatarOverlay + appshot 演示视频）**、地图（Mapbox）、Web Push 通知。

- **Walnut**：自研 Office 文档解码引擎（.NET 编译到 WASM，DocumentFormat.OpenXml），配套 9 个 Office 样板模板（budget-planner.xlsx 等）
- 29 个 IDE/编辑器图标（vscode/cursor/windsurf/zed/xcode/jetBrains 全家/终端 7 种/**devin/antigravity 竞品**）= "打开方式"检测

### 2.9 状态层（~/.codex 全目录语义）

| 路径 | 语义 |
|---|---|
| goals_1.sqlite（thread_goals/continuation_deferrals） | 任务目标与续跑延迟 |
| memories/ + memories_1.sqlite | 持久记忆系统 |
| queue_1.sqlite | 任务队列 |
| pets/ | 虚拟宠物状态 |
| rules/（default.rules） | 规则系统 |
| shell_snapshots/ | shell 环境快照 |
| sessions/ + session_index.jsonl | 会话转录与索引 |
| state_5.sqlite（thread_attachments/dynamic_tools/sections/project_roots/external_agent_config_imports） | app-server 状态层 |
| skills/、plugins/cache、computer-use/、ipc/、rollout-migrations/ | 技能/插件缓存/CUA 安装/IPC 套接字/迁移 |
| config.toml | notify 钩子（turn-ended→SkyComputerUseClient）、模型 gpt-6-luna、reasoning effort、marketplace 源 |

### 2.10 开发者工作流

- **git-worker**：init/origins/snapshot/snapshotBranch/github-request/createPullRequest(AsDraft)/mergePullRequest + 配置键（pr-watch-instructions/auto-merge/poll-interval、commit-instructions、always-force-push、review-mode、sidebar-pr-icons）
- **external-agent-import**：含 claude-cowork 字符串（竞品 agent 配置导入）
- LSP 自安装、29 IDE 检测、devbox-vnc 远程开发盒

## 3. 与 FreeCodeZ 差距矩阵（效果标尺）

### 3.1 已对齐 / 基本对齐（无需动作）

Electron 壳 + stdio/JSON-RPC agent、MCP 客户端、插件+技能体系、市场分发、ripgrep、会话持久化、多窗口、深链、自动更新、多语言、命令面板、终端集成（node-pty 对 FreeCodeZ 终端）、worktree/PR 基础、桌面+CLI 双形态（Codex CLI 独立可用，类比 zcode-cli）。

### 3.2 Codex 独有（FreeCodeZ 空白，按效果分组）

**A. 浏览器（差距最大）**
1. 内嵌完整浏览器（profile/扩展/清除数据/账号切换/地址栏）且可注册为默认浏览器
2. 接管用户真 Chrome（Native Messaging 宿主 + 5 浏览器矩阵安装器 + CWS 扩展三渠道）
3. WebMCP（网页暴露 MCP 工具，Chromium 级支持）+ CDP 全访问开关
4. 下载/上传/历史分级审批 + 危险工具强制绑定安全文档（documents.json 门控）

**B. Computer Use**
5. 原生 AX 服务（sky 96MB）：授权引导插件、锁屏守护、normal/relaxed 两档强度、Appshot
6. computer-history（本地活动流+记忆）、record-and-replay（录屏转 Skill）、messages（读发 iMessage）
7. 日历/提醒事项读写（权限声明里明示 update）

**C. 文档/产物**
8. Walnut .NET-WASM Office 解码（docx 预览/表格编辑器/幻灯片）+ 模板库
9. 内置 tectonic LaTeX + 托管 TeX Live 安装器（FreeCodeZ 靠 pdf 技能外置）
10. deep-research 多轮取证→引用报告；visualize 图表运行时

**D. 语音**
11. 全双工语音（WebRTC+VAD+听写+语音信箱+8 角色+AirPods 联动+频谱可视化）

**E. Agent 运行时**
12. code-mode-host：给模型的 V8 沙箱 JS 执行环境（cell/限额/yield）
13. OS 级三平台沙箱（Seatbelt/Landlock/Windows service）+ Starlark 策略
14. app-server daemon（版本探测/热重启/SSH 远程管理）
15. LSP 运行时自安装（kotlin/rust-analyzer/ty）

**F. 状态/智能**
16. goals（任务目标+续跑延迟）、memories（持久记忆）、rules、queue 独立子系统
17. Aeon 云执行后端（durable 环境、云侧对话）
18. 连接器生态（88 应用）+ 深度研究 + 购物/学习表面

**G. 交互/硬件**
19. quickChat 全局热键浮窗、avatarOverlay 虚拟宠物（Orbit）、Codex Micro 硬件外设、远程画中画（可投到虚拟宠物）
20. `.skill` 文件类型双击安装；hooks→MCP 工具生命周期转发；agents/openai.yaml 技能界面化；按工具粒度审批
21. external-agent-import（从 claude-cowork 等竞品导入）

**H. 企业/运维**
22. Sentry+OTel+Statsig 三通道、trace 录制上传、任务管理器、系统状态页、企业 workspace policy、Intel 警告、MSIX/deb/rpm 矩阵、运行时热更新通道（primary-runtime）

### 3.3 FreeCodeZ 独有（不对齐项）

四宿主形态、Bot 异步双通道（TG 等）、手机 LAN relay 远控（Codex 手机侧走 ChatGPT app 生态）、编程/办公双模式 UI、插件商店化、serve --daemon、多供应商模型接入（MoMA 等）。

## 4. 反编译/处理可行性（已完成部分）

| 层 | 可行性 | 状态 |
|---|---|---|
| 插件层（plugins/） | 明文，零成本 | ✅ 已全量清查 |
| 主进程（.vite/build 35 bundle） | minified 可恢复 | ✅ 已特征提取（IPC/窗口/协议/菜单） |
| 渲染层（webview 19K chunk） | 无 source map，结构可见 | ✅ 已功能面挖掘 |
| codex 主二进制（Rust） | 开源仓 openai/codex 可对照 0.159.x | ✅ strings 特征已提取 |
| code-mode-host / node_repl / voice-host | Rust，仅 strings | ✅ 已 strings 级分析 |
| 原生 .node / sky .app | Mach-O，仅符号级 | ⚠️ 未深入（按需） |

解包产物：`~/Desktop/swarm-os/codex-app-analysis/app`（538MB，仓库外）。
合规边界：明文资源（plugin.json/skills/文档）可作行为规格参照；代码不可直接搬入 FreeCodeZ，需重新实现。

## 11. 安装包与分发链（DMG 视角，2026-10-01 补充）

原始安装包 `/Users/homebaby/Downloads/ChatGPT.dmg`（744MB，UDZO 压缩率 0.39，sha256 `421d804c…`），与已装版本同 build 12404：

- **签名链完整**：Developer ID Application: OpenAI OpCo, LLC（Team 2DC432GLL2）→ 公证（source=Notarized Developer ID）→ **stapler 装订**（离线可过 Gatekeeper）；`codesign --deep` 校验通过。
- **配置描述文件**：`Codex Desktop AKV 2026-05-24`（AKV = Azure Key Vault 云端密钥签名），有效期至 **2044-07-16**，AppIDName "Codex Desktop"。
- **Electron fuses 全量加固**（实测 @electron/fuses read）：`RunAsNode: off`、`EnableNodeOptionsEnvironmentVariable: off`、`EnableNodeCliInspectArguments: off`、`EnableEmbeddedAsarIntegrityValidation: on`（**asar 哈希烙进二进制，改包即拒载**）、`OnlyLoadAppFromAsar: on`、`EnableCookieEncryption: on`、`GrantFileProtocolExtraPrivileges: off`。
- **Sparkle 2.9.1 增量更新**（实测拉取 appcast）：日更节奏（最新 12553 发布于 2026-09-30 23:53）；12404→12553 的 **delta 仅 2.26MB（全量 682MB，约 300 倍缩减）**；delta 回溯 5 个历史版本（12111/11431/11645/12246/12404），每个 delta 独立 EdDSA 签名；arm64 硬件要求标注。
- **分架构构建**：DMG 为 arm64 单架构（配合菜单 intelLaunchWarning 文案，存在独立 Intel 包）。
- **DMG 装帧**：自定义卷图标（.VolumeIcon.icns）、背景图、Applications 符号链接——标准专业安装体验。
- **原生小二进制功能确认**：bare-modifier-monitor=双击/裸修饰键热键监视（双击 Cmd 唤起浮窗）；remote-control-device-key=Secure Enclave 设备密钥 create/sign；usb_webauthn.node=libfido2 USB 安全键；launch-services-helper=CLI 子命令集（set-app-icon / dock 修复 / 下载完成通知）；airpods-mute=默认输入设备监听+静音同步；dock tile 插件=主题感知图标切换（icon-codex/space × light/dark）+通知角标。

## 12. preload 层与启动时序（此前未覆盖的最后一块）

35 个主进程 bundle 已全部定性（最大 main 3.7MB / worker 2.4MB / bootstrap 2.2MB）。新发现：

1. **"Owl" Node 权限模型网络沙箱**（startup-requirements）：app-server 声明网络需求后，主进程**剔除 argv 里全部 `--permission/--allow-*` 与 NODE_OPTIONS，注入 `--codex-node-network-restricted --allow-fs-read=* --allow-fs-write=* --allow-addons --allow-child-process --allow-worker --allow-ipc=<CODEX_HOME>` 然后 `app.relaunch()` 自重启**；重启后断言 `process.permission.has('net')===false` 否则拒绝启动。即主进程整体运行在 Node 20+ 权限模型下做域名级出网限制（URL 门禁仅放行 app:/codex-sandbox:/data:/blob:/file: 与 https allowlist）。
2. **内嵌浏览器代号 "Owl"**：`owl-scoped-user-agent-prefix=CodexBrowser` 仅对 openai.com/chatgpt.com/chatgpt.site/chatgpt-team.site 追加 UA 前缀（不污染普通站点指纹）；无条件启用 blink `WebMCP` + `DevToolsWebMCPSupport`。
3. **WebMCP 站点直通**：页面 preload 监听标准 `document.modelContext` toolchange 上报 `webmcp_changed`；策略上限 maxTools=100、描述符总量 64KB、注册变更 10 次/页——**任意网站可把自己注册为 Codex 的 MCP 工具提供方**。
4. **站点注解 API（面向第三方网站作者的公开 DOM API）**：`codex:register-annotation-controls`（64 控件/1024 目标/16KB 上限）、`codex:open-annotation` 拦截、`codex:annotation-surface-*` 协商、oaiannotationmodechange 通知；需主进程授权 + `navigator.userActivation.isActive()` 且 agent 未控制浏览器时才可用。
5. **内嵌浏览器页面桥极薄**：仅 5 个 IPC 通道（webmcp_changed / 注解特性上报 / 侧栏评论运行时 / 两个 sendSync 策略查询）；评论/注解运行时 28 种双向消息；捏合缩放到 3x、鼠标 3/4 键转导航、图片拖拽上报。
6. **chunked-message-v1 流式 token 协议**：主→渲染器大对象不走整包 JSON，而以 `{start, chunk(array-start/object-start/string-chunk…), end}` token 流传输、逐序 ack——自研增量 JSON 流式反序列化，边收边渲染。
7. **远程托管浏览器画中画 = WebCodecs 硬解管道**：远端浏览器视频以编码帧（codec+decoderConfiguration+videoData+keyframe）推给 preload，`VideoDecoder(prefer-hardware, optimizeForLatency)` 硬解后 transferable VideoFrame 投页面；配 WebRTC DTLS1.3 fieldtrials。
8. **MCP App 沙箱"端口即 API"**：widget iframe 必须一次性提供 12 个具名 MessagePort（navigate/runWidgetCode/setWidgetData/setTheme/setSafeArea/…，缺一拒绝），宿主反向 7 端口含 `applyAutofillCandidate`（代填表单）与 `screenshot`（视口截图）；唯一沙箱域 `web-sandbox.oaiusercontent.com`，本地开发走特权协议 `codex-sandbox:`。
9. **MCP Tasks 扩展进协议层**：`io.modelcontextprotocol/related-task`（tasks/get/result/list/cancel + 状态通知，status: working/input_required/completed/failed/cancelled）——widget/工具层的长任务异步轮询模型。
10. **Codex Micro 实体键盘完整实现**（service bundle 29KB + hid-topology-watcher）：USB vendor 12346（CodexMicro/CreatorMicroV2），按线程槽位 AG0-AG5 六键驱动 RGB（working=snake 流水、选中=breath、录音=绿蛇、处理=白蛇），摇杆死区 0.05、电池 60s 轮询、不活动熄灯、传输不可用降级+重连退避。
11. **chatgpt.com/browser/handoff 深链 + macOS Handoff**（NSUserActivityTypeBrowsingWeb）：网页版浏览器标签页可移交桌面内嵌浏览器，事件跨重启排队（CODEX_DESKTOP_RELAUNCH_OPEN_EVENTS）。
12. **杂项**：日志 {safe,sensitive} 双桶 + 500 条启动环形缓冲；错误序列化 cause 链 3 层/message 16KB 截断；虚拟宠物预览帧用 Document-Isolation-Policy（非 COOP/COEP）+ 每帧 16-hex 内容哈希 URL；codex 二进制定位链 5 级回退（含 Windows AppContainer `native-executables.json` realpath 校验、WSL WSLENV 传递、.cmd shim 解析）。

## 5. 建议下一步（按用户四原则过滤）

以"安全不添麻烦/不丢上下文/不做熔断/无常驻 shell"为过滤器，3.2 中值得进 SPEC 议题的效果：

1. **审批粒度**：按工具 approval_mode（prompt/approve）+ 危险工具绑定文档——符合"安全不添麻烦"
2. **hooks 生命周期转发**（Interrupt/Stop→MCP 工具）——轻量，FreeCodeZ hooks 体系可平移此效果
3. **`.skill` 文件类型安装** + skills 的 agent 界面化（openai.yaml）——与现有 skill 体系直接互补
4. **documents.json 文档门控**（工具级文档加载策略）——直接回应 MCP 零护栏 token 成本问题（对照 skill-plugin-context-costs 记忆）
5. **computer-history / record-and-replay** 的"活动流+录转技能"效果——CUA broker 强化方向的参照
6. LaTeX 托管运行时（`~/.cache/codex-runtimes` 模式）——重工具按需下载而非随包
