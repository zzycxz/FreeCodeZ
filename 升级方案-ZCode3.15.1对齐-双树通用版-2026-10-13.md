# 升级方案·双树通用版：完整对齐 ZCode 3.15.1（FreeCodeZ / quartet 通用）

日期：2026-10-13 ｜ 上游对照物：ZCode 3.15.1（/Applications/ZCode.app，与 Downloads 的 ZCode-3.15.1-mac-arm64.dmg **逐字节一致**，已 cmp 验证）｜ 基线：两树均为 3.14.0 同源 fork

> 本文件自包含，可整份复制到 quartet 仓库根使用。FreeCodeZ 专属的调查过程与证据链见同目录《升级方案-ZCode3.15.1对齐-2026-10-12.md》（本文件是其执行版浓缩+双树化）。

## 0. 怎么用这份文档

- **FreeCodeZ**：直接按批次执行。R1 已裁决（保留 retune 原地调并发）。
- **quartet**：①先跑 §3 末尾的「自查命令块」复核现状列；②先补齐树内既有的《上游修复移植五批次指导书》（3.14.x 官方修复，quartet 尚未应用），再上本方案——否则工作流健壮性面会缺底座；③R1 对 quartet 的默认=**直接照抄上游世代语义**（quartet 没有 retune 特例，无需裁决）。
- 政策（用户裁决，两树一致）：**能完整抄袭的尽量完整抄袭**——前端界面+后端逻辑按上游原实现移植，不做「自研一个类似的」；唯一允许偏差=§8 最小改名面。

## 1. 背景与判定汇总

3.15.1 更新日志 23 条（新功能 11 + 修复 12），剔除 GLM 账号独有 3 条（邀请活动/HighSpeed 订阅体验/额度重置入口）。逐条判定结果：

- **✅ 可 1:1 复刻 15 项** → 按 §4/§5/§6 批次执行
- **⚠️ 部分 2 项**（工作流状态修复 F2、会话加载 F10：修复本体在上游 minified 双版 diff 中不可见，走「可见部分移植+回归收口」，各留半天级深挖路径）
- **❌ 不复刻 4 项**（账户菜单/额度入口=账号面、加速回合=HighSpeed、更新复查=更新链已删且自有等价物）

## 2. 上游源码恢复能力与移植方法论（两树通用）

### 2.1 事实：上游源码拿不到现成的

| 路径 | 结果 |
| --- | --- |
| sourcemap | 无（out 全目录无 .map；main/index.js 与 glm/zcode.cjs 尾部无 sourceMappingURL） |
| 官方 npm | @zcode/* 不发布（Not Found） |
| asar 内 node_modules | 无自家 scoped 包（全第三方） |
| 官方源码树 | 无公开渠道 |

### 2.2 三条移植通道（按内容类型选用）

1. **明文资产逐字抄**：`/Applications/ZCode.app/Contents/Resources/glm/packages/*` 全是明文——visualize-plugin 全套（SKILL/assets/scripts/widgets/references/tweak.md）、dynamic-workflows SKILL §15、各插件 docs。逐字复制到树内 `upstream-assets-3.15.1/` 后搬运。
2. **同源反编译**：两树都是 3.14.0 同库 fork，上游 minified 带 esbuild `s(fn,"原名")` 真实函数名注解——把 3.15.1 逻辑差异对照树内同源文件解码成 TS 补丁贴回；UI 解码到类名+文案键+交互。适用于滚动修复/guarded/contentRejected/确认卡调参/托盘。
3. **新增模块 1:1 重建**：3.15.1 全新文件（plugin-sandbox、站点权限 policy/store、网络捕获、GenUI service）按上游结构/命名/状态机解码为独立 TS 模块，不做本树风格重构。

### 2.3 反编译工具链（复现命令）

```bash
# 解包（asar 工具用树内 node_modules 的）
node <树根>/node_modules/@electron/asar/bin/asar.js extract \
  /Applications/ZCode.app/Contents/Resources/app.asar /tmp/z3151/app
# 3.14.3 旧版对照（DMG 挂载后同法解包）
hdiutil attach -readonly -nobrowse -mountpoint /tmp/z3143-dmg ~/Downloads/ZCode-3.14.3-mac-arm64.dmg

# i18n 词表 diff（定位功能锚词；IntlProvider chunk 是字符串总库）
# 抽两版中文串集合做差，得新增词表 → 逐条映射到功能

# 函数名集合 diff（完整性审计；esbuild 注解正则）
/[rs]\([A-Za-z0-9_$]+,\s*"([A-Za-z0-9_$]{3,})"\)/g

# 上下文提取（minified 定位后看 ±N 字符）
node -e '/* 读文件、正则找锚点、slice 上下文 */'
```

### 2.4 关键上游锚点速查（minified 文件+字节偏移）

| 功能 | 文件 | 偏移 |
| --- | --- | --- |
| 危险命令引擎 matchDangerousCommand | glm/zcode.cjs | 7359439（规则构造 7359870） |
| guarded 决策点 checkPermission | glm/zcode.cjs | 5210104 |
| 站点权限 applyEmbeddedBrowserPermissionPolicy | out/main/index.js | ≈527158 |
| 站点权限 store | out/main/index.js | ≈742108 |
| file 打开 zk（fileURLToPath→openPath） | out/main/index.js | ≈709424（zk@655320） |
| 预热 3→1 | out/main/index.js | ≈354716（host schema .max(1)） |
| 协议注册补 `--` | out/main/index.js | ≈373022 |
| 托盘/Linux 探测 | out/main/index.js | ≈573518-577500 |
| 滚动修复（resize 处理器） | out/renderer/assets/styles-D-FzO2Ov.js | ≈3426297 |
| 网络捕获 createNodeNetworkCapture | glm/zcode.cjs | ≈507704 |
| NetworkCaptureBuffer（main） | out/main/index.js | ≈467760-469700 |
| hole 引擎/FillWorkflowHole | glm/zcode.cjs | 7799972/1468239 |
| contentRejected failRecovery（3.14.3） | out/renderer/assets/styles-DEELZGp2.js | ≈118232/942800-946400 |
| elide 三函数 | glm/zcode.cjs | ≈913963 |
| 飞书直连注册/API/WS | out/host/index.js | 646900-734000 |
| 自主模式 i18n（guarded=「自主模式」） | out/renderer/assets/IntlProvider-*.js | ≈285406 |

## 3. 双树判定矩阵（现状均已实证，quartet 附自查命令）

| # | 条目（上游判定） | FreeCodeZ | quartet | 批次 |
| --- | --- | --- | --- | --- |
| N1 | 自主模式 guarded（✅抄） | 无 guarded，基础设施齐 | 无 guarded（contracts 无此词） | U2-1 |
| N2 | 可视化交互界面（✅抄） | 零基础 | 零基础（同源推断） | U3-1 |
| N3 | UI 插件 MCP App（✅抄） | 零基础 | 零基础 | U3-2 |
| N4 | 工作流创建前调参（✅抄）；改并发/复跑 | 已有改并发（retune）+复跑，缺调参卡 | **需自查**（无 FC 的 retune/op-log 批次；改并发语义=纯上游） | U2-5 |
| N5 | 子代理单独模型 | 已有 | **已有**（quartet-cli create-workflow.ts:168）；3.15 绑定校验两树都缺 | U2-5 |
| N6 | 飞书群/话题（✅可抄不绑云） | 有第一代底座 | **需自查**（剥离时可能已删） | P3 |
| N7 | 浏览器站点权限（✅抄） | 无+默认全放行 | 无+默认全放行（0 handler） | U1-4+U2-4 |
| N8 | Linux 托盘（✅抄） | win-only | win-only（同源） | U3-4 |
| N9 | 账户菜单（❌账号面） | 不适用 | 不适用 | — |
| F1 | 加速回合丢消息（❌HighSpeed） | 不适用 | 不适用 | — |
| F2 | 工作流状态显示（⚠️回归收口） | 同域自研已覆盖 | **无自研覆盖**（缺五批次）→ 先补五批次 | U2-5 |
| F3 | 更新失败复查（❌链已删） | 不适用 | 需自查更新链现状 | U1-5 |
| F4 | 权限默认放行（✅=N7） | **实锤** | **实锤** | U1-4 |
| F5 | 本地文件打开（✅抄） | **实锤双重断裂** | **实锤**（preload:570 发 OpenExternalFile，main 无 handler；openPathInDefaultApp 仍在 helpers:12） | U1-1 |
| F6/F7 | @提及/授权过期（✅随 N6） | 随 N6 | 随 N6 | P3 |
| F8 | 额度重置（❌账号面） | 排除 | 排除 | — |
| F9 | 滚动跳动（✅抄） | **实锤**（ConversationTimeline.tsx:103,1059-1092） | **实锤**（:103 同款） | U2-2 |
| F10 | 会话加载卡住（⚠️可见部分抄） | 裸 parse×3+无超时 | **实锤**（codecs.ts 同 3 处 JSON.parse） | U2-3 |
| F11 | Windows 链接安全（✅5 行） | **实锤**（desktopOAuthDeepLink.ts:409/426 无 `--`） | **实锤**（:409/:426 无 `--`，scheme=`quartet`） | U1-2 |
| F12 | 多工作区卡顿（✅2 行） | **实锤**（startupWorkspace.ts:40 LIMIT=3） | **实锤**（:40 LIMIT=3） | U1-3 |
| 加 | 资源管理器网络标签页（更新日志未提，✅抄） | 无 | 需自查（大概率无） | U2-6 |

**quartet 一键自查块**（复制执行，复核上表「需自查」项）：

```bash
Q=/Users/homebaby/Desktop/swarm-os/quartet
grep -m1 '"version"' $Q/package.json                                  # 基线
grep -n 'STARTUP_AGENT_WARMUP_LIMIT' $Q/packages/desktop/src/main/startupWorkspace.ts
grep -n 'setAsDefaultProtocolClient' $Q/packages/desktop/src/main/desktopOAuthDeepLink.ts
grep -rn 'setPermissionRequestHandler' $Q/packages/desktop/src/main/ | wc -l
grep -rln 'OpenExternalFile' $Q/packages/desktop/src/main/            # 空=死通道
grep -n 'JSON.parse' $Q/apps/quartet-cli/packages/adapters/src/storage/session-store/codecs.ts
grep -n 'CONTENT_WIDTH_RESIZE_SETTLE_MS' $Q/packages/ui/src/v4/ConversationTimeline.tsx
grep -rn 'guarded' $Q/apps/quartet-cli/packages/contracts/src/ | head -3   # 空=无
grep -c 'downloadUpdate\|quitAndInstallUpdate' $Q/packages/desktop/src/preload/index.ts
grep -rn 'feishu\|lark' $Q/packages/services/src --include='*.ts' -l | head -3  # 飞书底座有无
grep -c 'networkCapture' $Q/packages/shared/src/channels.ts           # 0=无网络标签页
```

## 4. U1 批：止血（全 S 级，两树可立即开工）

### U1-1 本地文件「在默认浏览器/默认应用中打开」断裂

- **上游机制**：OpenExternal handler 增加 file: 分支——`fileURLToPath` 转路径 → normalize+realpath → `shell.openPath`，不再交给 openExternal（main@≈709424，函数 `zk`@655320）。
- **双树现状**：preload 都发 `PlatformChannels.OpenExternalFile`（FC preload:658 / quartet preload:570），main 都**无 handler**（FC 的原 handler 随 desktopMainIpcRemote.ts 在 8ccf9b9c 被删成 6 行 stub；quartet 同样没有）；`openPathInDefaultApp` 都还在 desktopMainIpcHelpers.ts:12 成死代码。FC 另有一层：`UnifiedBrowserView.tsx:917-925` 的 file:// URL 被 desktopMainIpcPlatform.ts:189-194 的 http(s) regex 静默吞。
- **移植步骤**：①恢复 handler（原文，两行）：
  ```ts
  ipcMain.handle(PlatformChannels.OpenExternalFile, async (_event, rawPath: string) =>
    openPathInDefaultApp(rawPath, options.logger),
  );
  ```
  挂到树内现存 IPC 注册点（不要恢复整个被删文件）。② OpenExternal handler 加 file: 分支走 fileURLToPath→openPathInDefaultApp，**不放宽**现有 http(s) 白名单 regex。
- **验收**：内置浏览器打开本地目录站点→工具栏按钮成功唤起默认应用；本地预览卡点文件不再报「打开失败」。

### U1-2 Windows 协议注册参数注入（补 `--`）

- **上游机制**：win32 下 `setAsDefaultProtocolClient` 注册命令追加尾部 `"--"`（defaultApp 与 packaged 两分支都改，main@≈373022）——Windows 协议激活时 URL 追加进命令行，缺 `--` 时链接内容可能被 Chromium 当作命令行开关。
- **双树现状**：FC scheme=`freecodez`、quartet scheme=`quartet`，注册处都在 desktopOAuthDeepLink.ts:409（`[entry]` 无 `--`）与 :426（裸调用）。
- **移植**：两分支各加 `"--"`（仅 win32），约 5 行。
- **验收**（Windows）：注册表协议命令含 `--`；伪造含 `--`/空格参数的链接不产生额外开关。

### U1-3 多工作区启动卡顿（预热 3→1）

- **上游机制**：启动 Agent 预热目标 3→1（main 常量 main@≈354716 + host 协议校验 `.max(1)` 同步）。
- **双树现状**：startupWorkspace.ts:40 `STARTUP_AGENT_WARMUP_LIMIT = 3` + shared validation `.max(3)` 两树相同。
- **移植**：常量 3→1 + schema `.max(1)` + 同步注释。约 2 行+注释。
- **验收**：恢复 3 个 workspace 的冷启动只拉 1 个 agent 预热进程；切其它 workspace 按需冷启动。

### U1-4 浏览器权限默认放行止血（完整体系见 U2-4）

- **上游机制**：embedded session 装 `setPermissionRequestHandler/CheckHandler/DevicePermissionHandler/setDisplayMediaRequestHandler`——allowlist 自动放行 4 项（clipboard-sanitized-write/fullscreen/pointerLock/mediaKeySystem）+ 13 项可询问 + **其余 default-deny**（main@≈527158）。
- **双树现状**：main 全目录 0 个 permission handler → Electron 默认**自动批准一切**（任意网页静默拿摄像头/麦克风/定位）。embedded partition：FC=`persist:freecodez-embedded-browser`（browserDataManager.ts:31）、quartet 按树内常量。
- **移植（止血版）**：先只装「allowlist+其余默认拒绝」——暂不弹询问（全拒绝）也比静默放行摄像头安全。
- **验收**：内置浏览器打开请求摄像头的网页→权限被拒绝。

### U1-5 死 IPC 清理

两树 preload 都暴露 `downloadUpdate`/`quitAndInstallUpdate` 而 main 无 handler（调用必 reject）。摘除。（quartet 若更新链未删则此项改按 F3 处理——自查。）

## 5. U2 批：高价值移植（M 级为主，先出作业手册再动码）

### U2-1 自主模式 guarded 档（最高价值）

- **上游机制（完整解明）**：新增 `guarded` 档 = yolo 语义 + 危险命令单次确认。判定=纯静态 shell 解析黑名单（非 LLM）：完整 shell parser（posix/cmd/git-bash 三方言）→ 递归解壳（sudo/env/time 包装、`bash -c` 再解析，解释器集合 bash/sh/zsh/cmd/powershell/eval/source/python/node/perl/ruby）→ 规则库（ruleId `safety.bash.*`）：
  `rm -r/-R/--recursive`（多目标或未引号 glob）→ remove-critical-path；`dd/mount/umount/mkfs*`→system-storage；`rsync --delete`（排除 -n dry-run）→rsync-delete；git：`reset --hard`（--soft/--mixed/--dry-run 不拦）/`clean`/`push --force`（--no-force 不拦）/`checkout`/`restore`/`stash clear`/`worktree remove --force`；cmd 方言 `rd/rmdir/del/erase`、`find -delete`、`robocopy /MIR`。
  **尊重显式保护 flag**；命令>10000 字符/legacy-shell/解析失败/含动态词→不询问直接执行（保守方向）。命中→`ask(..., riskLevel, approvalMode:"user-once")` 复用既有权限面板（仅此一次/始终允许相同命令/拒绝，suggestedPermissionUpdates 落规则）。未命中=完全等同 yolo。
- **双树现状**：均无 guarded（4 档 build/edit/plan/yolo）；同源的 shell 解析器、ask 流、suggestedPermissionUpdates、手机端权限应答（web-remote-control respond_permission）基础设施都在。
- **移植**：①规则引擎逐条搬进同源 permission service（FC 有 catastrophicFloor 灾难地板=yolo 前置 4 类 deny，保留作兜底，与 guarded 并存）；②档位贯通 5-6 处 schema（contracts session.port + shared execution-state/zcode-protocol + UI projection + i18n，文案照抄：guarded=「自主模式」/「在有风险时询问」）；③接入顺序=guarded 命中规则 ask > yolo/guarded 放行；④（建议）workspace 维度默认模式：本机默认 guarded、远程 workspace 显式 yolo——ask 推手机，远端无人值守零打扰。
- **验收**：本机放开跑，执行 `git reset --hard` 时弹确认（手机可批），选「始终允许」后同类不再问；远端会话完全访问零打扰。

### U2-2 窗口 resize 滚动跳动

- **上游机制**：修复不在滚动守卫（两版一致），在 resize 处理器：ResizeObserver **同时观察滚动容器**（高度变化也触发）；**贴底（following）态当帧同步处理**：摘 observer → 置标志禁用全部逐条滚动补偿 → `querySelectorAll(':scope>[data-index]')` 一次收集所有行真实高度 → `flushSync` 批量 resizeItem → 单次 scrollToBottom（校验用户没上滚）→ rAF 重挂。非贴底仅宽度变化时保留 120ms 去抖。
- **双树现状**：ConversationTimeline.tsx 只观察内容列宽度、settle 后才贴底（FC :103,1059-1092；quartet :103 同款）——纵向 resize 不触发、settle 前中间态可见。
- **移植**：单文件 ~100 行，按机制逐块移植（防 observer 自激）。
- **验收**：长会话贴底拖拽窗口四角不跳不漂；上滚后缩放窗口阅读位置不漂移。**双链路验证**：桌面实时链路 + 手机 web 恢复链路都要过。

### U2-3 会话健壮性（可见部分照抄+一处例外）

- **contentRejected（照抄 3.14.3 上游语义）**：assembler 16 个故障码两树 wire 层已全有；缺 store 层语义。移植落点（两树同源文件）：`conversationProjectionStore.ts` 六点（recovery 加 contentFault 字段/handleAssemblyFault 判 `proto.frameAssemblyInvalidPayload`→requestRecovery(true,{contentFault})/failRecovery 升级 `fault.subscription.contentRejected`/超时分支 contentEligible:false）+ `sessionsIndexStore.ts` 同款六点（升级时**停自动重试**）+ 可选 shared 守卫函数。renderer 本地派生终态码，UI 原样显示，无新 i18n。
- **elide 索引削重（照抄 3.15.1）**：`session/read` RPC 加 `contentProfile:"index"`——出口把 reasoning 文本清空、data: URL 归一、tool input/output/metadata 剥空。四处：shared read schema 加枚举 / CLI server-operations 解析+elide / services 透传 / taskIndexSyncer 回源带 index。服务于会话列表性能（1000 条上限防超大载荷）。
- **codecs 坏行容错（唯一允许的自研例外）**：`codecs.ts:84/117/159` 三处裸 `JSON.parse`（decodeMessageRow/decodePartRow/decodeSessionEntryRow，两树同）——加 per-row try/catch+告警跳过。上游实现不可见，作业手册标注。
- **awaitingInitial 兜底超时**：conversationProjectionStore 加载态无超时→加超时转 error。
- **验收**：手写坏 JSON 行+超大 data: URL 消息，会话仍能打开绝不无限转圈；坏帧 forceSnapshot 再失败显示 contentRejected。

### U2-4 站点权限完整体系（U1-4 之上，1:1 重建）

- **上游机制（全解明）**：持久化 `<userData>/embedded-browser-site-permissions.json`（origin×permission，allow/deny，临时文件+rename 原子写）；决策序=持久设置→本次运行 session-allow→UI 询问（20 秒超时=拒绝）；prompt 四态（始终允许=写 allow/仅本次=内存 set/阻止=写 deny/不允许=dismiss）；管理页 13 项权限三态下拉（询问=删条目）+重置，挂侧栏 browser-permissions tab；IPC 6 通道（prompt/resolve/get/set/clear/reset）。13 项可询问：media/clipboard-read/geolocation/notifications/midi/midiSysex/idle-detection/speaker-selection/window-management/storage-access/top-level-storage-access/keyboardLock/fileSystem；usb/hid/serial 走设备选择器；蓝牙独立 guard；屏幕共享 desktopCapturer 选屏。
- **移植**：四模块按上游结构建（shared 通道+类型 / main policy+store+bridge / preload / UI 三件：prompt 卡按 guestWebContentsId 过滤+管理页+i18n 双语逐条抄）。默认策略照抄：**绝不静默放行 media/geolocation**。
- **验收**：网站请求摄像头弹「{origin} 想要使用摄像头」卡，「仅本次」当次可用刷新再问；管理页改「允许」不再问；20 秒不操作自动拒绝。

### U2-5 工作流：创建前调参 + 模式三态 + 状态回归 + 绑定校验

- **上游机制**：确认卡新增 limit/model 控件（i18n `chat.permission.workflow.settings.*`：最多 N 个子代理同时运行/不设上限/原为 {value}/恢复原值/子代理默认沿用会话模型），确认时并入 CreateWorkflow 载荷；host 新设置键 `dynamicWorkflowMode`（禁用/通过命令启用/始终开启）+设置页三态；SKILL §15 留白作者契约；3.15 新增 actor 模型绑定校验（bindScriptModels/WorkflowActorModelUnboundError/allScriptModelsBound）。
- **双树现状**：确认卡只读（FC `packages/ui/src/WorkflowPermissionBlock.tsx`）；模式设置 FC 有 env 灰度层（desktopRuntimeEnv.ts:529）无用户键——移植=设置键优先+env 兜底；quartet 无 retune 特例，改并发语义直接照抄上游世代（settings-<uuid>/supersededRunId/跟随）。N5 绑定校验两树都缺，本批补抄。
- **R1 树专属**：FC=「并发-only 调整走 retune 原地生效，其余照抄」（已裁决）；quartet=默认全照抄。
- **验收**：确认前调并发+指定子代理模型起跑即生效；「自动化 › 工作流」按名复跑可再调参；五条状态回归断言（resume 一致性/amend 在途拒绝不残留/retune 或世代不闪变/已取代 run 不显示为活动/settings 血统解析——quartet 适用）。

### U2-6 资源管理器「网络」标签页（更新日志未提；外发治理观测层）

- **上游机制（规格级全解明）**：window-scoped——开资源管理器窗口才采集（captureId=randomUUID），关窗即停并清零；「清空」=captureId 全局轮换。三源汇入 main 1000 条环形缓冲（dropped 计数）：① Electron `session.webRequest.onBeforeRequest`（defaultSession+自定义 partition，http(s)/ws(s)，合并订阅器防 Electron 单监听器互顶，排除内嵌浏览器 guest）；② main 自身 Node 出网（diagnostics_channel undici/http）；③ host/CLI 转发（CLI 经 `process/networkRequests` JSON-RPC 通知→host 补 pid→`network-capture-batch` 端口消息回 main）。每进程 100 条/250ms 批量。记录 6 字段 `{id,timestamp,processType(main|host|renderer|cli),pid,method(≤32),url(≤2048)}`，无状态码/字节数。
- **脱敏（不可打折）**：四进程边界统一 sanitize（query 值全 `[redacted]` 键保留、userinfo 凭据删除、hash 删除、非 http(s)/ws(s) 丢弃、2048 截断）；MCP OAuth/官方 auth 流量 AsyncLocalStorage 整体排除。建议 sanitize 放 shared 单点（上游是四处副本）。
- **UI**：500ms 轮询（无推送）、每页 100、时间/进程PID/方法/URL 四列、单框过滤、空态两态；i18n 13 键（resourceManager.network.*）。
- **移植落位**：shared 新建 networkCapture.ts（类型+zod+sanitize 单点）→ main 新建 resourceManagerNetwork.ts（对标既有 resourceManagerStorage.ts；生命周期挂 openResourceManager；鉴权复用窗口 webContents.id 模式）→ host 侧 spawn 后 register → **CLI 侧 createNodeNetworkCapture 一并移植进 vendored CLI（两树 CLI 都无此代码）** → preload 桥+NetworkSection 组件+i18n。
- **验收**：跑对话时网络 tab 实时出现到模型 API 的请求（query 显示 [redacted]），筛选/清空/关窗清零符合预期。

## 6. U3 批：大功能（先写 spec 再实施；**U3-0 基座先行**）

### U3-0 plugin-sandbox 沙箱基座（U3-1/U3-2 共用硬前置）

上游新增 `out/plugin-sandbox/` + `preload/pluginSandbox.cjs`：main 注册特权协议 `zcode-sandbox://`（CSP frame-src 白名单+permissions-policy 全禁 camera/mic/geo）+ per-app 持久 partition（sha256(appIdentity)）+ webRequest 白名单校验 + `will-attach-webview` 分流专用 preload + 并发卡片配额。**红线**：树内 renderer 无 CSP，已有「刻意不做 iframe」书面决策（WorkflowArtifactBody.tsx:32）——必须完整搬双隔离（webview+内层 sandboxed iframe+provenance 校验），不可降级为直接 iframe。

### U3-1 Gen UI 交互视图（M+基座）

agent 按 visualize skill 写 HTML fragment→会话目录（env `*_GEN_UI_OUTPUT_ROOT`/visualizations，scope key=[workspaceIdentity||path, sessionId]）→正文行 `::visualize{json}` 引用→消息流内联沙箱卡（初始 240px 随内容至 10000px）。桥 4 API（widgetState≤16KiB/setWidgetState/sendFollowUpMessage 需确认弹窗/openExternal）。follow-up 归因「来自交互视图」。visualize-plugin 明文资产整套复制。web/手机端降级提示「请在桌面端打开」。协议 input.source.genUi 按树内 v4 适配。

### U3-2 UI 插件 MCP App（M-L+基座）

MCP server 在 resource 注解 ui 对象声明（兼容 Codex 键 openai/widget*）→host 拉取内容重发布到 zcode-sandbox://→双隔离加载→ui/* RPC（message/update-model-context/callTool/initialize…）→「插件想以你的身份发送消息」**强制可编辑确认对话框**（钓鱼面不可静默）→App Tools 反向通道（插件注册工具模型可调）。卡片挂工具调用、可 pin/重试/superseded 替换/开侧栏。

### U3-3 工作流留白（hole，L，引擎级新原语）

脚本 `hole()` 挂起（holeSiteId=FNV-1a `hole#xxxxxxxx`）+run 状态机 holes 字段（waiting/filled）+FillWorkflowHole 工具（被拒补全存 fill 文件）+补全重放+确认卡（留白补全草稿/待确认/已补全）+SKILL §15。需同时验证桌面实时链路与手机恢复链路。SKILL 更新基于树内既有 0.3.0 底座再升。

### U3-4 Linux 托盘驻留（M-L，两树都发 Linux 包）

托盘创建扩 linux（png 图标）+DBus StatusNotifierWatcher 三命令探测（gdbus/busctl/qdbus，1.5s 超时）+能力监视器（10s 缓存）+关窗判定扩 linux+一次性迁移键+IPC `GetCloseToTrayCapability`+三态设置 UI（含 GNOME AppIndicator 提示文案）。

## 7. 不复刻清单（4 项）

| 条目 | 原因 |
| --- | --- |
| 账户菜单套餐/复制用户 ID（N9） | 依赖已删除的官方账号链；两树均已去登录 |
| 额度重置入口（F8） | GLM 账号独有 |
| 加速回合消息丢失修复（F1） | HighSpeed 为 GLM 账号功能；公共路径（CommandInbox 队列）已验证低风险 |
| 更新失败复查（F3） | 更新链已删（FC；quartet 自查），自有 updateChecker 已带失败退避 |

## 8. 最小改名面清单（唯一允许的与上游差异）

| 面 | FreeCodeZ | quartet |
| --- | --- | --- |
| 用户可见文案品牌 | ZCode→FreeCodeZ（P10 规则） | ZCode→quartet（按其剥离记录） |
| 家目录 | `~/.zcode`→`~/.freecodez`（workflows 等） | 按树内既有约定自查 |
| 深链协议 | `freecodez://` | `quartet://`（desktopOAuthDeepLink.ts:405） |
| embedded partition | `persist:freecodez-embedded-browser` | 按树内常量 |
| env 变量 | FREECODEZ_* 双写约定（7 键先例） | quartet env 双读 7 键先例 |
| 账号链引用 | 删除（两树同） | 删除 |
| IPC 通道名 | 保留 `zcode:` 前缀（树内现状） | 按树内现状 |

其余一切（布局/交互/状态机/协议字段/文案措辞/i18n 键值）与上游一致。**并存自研增强不因对齐而拆除**（FC：retune/amend 互斥/op-log/灾难地板/workspace 默认模式；quartet 按 §0 先补五批次后同理）。

## 9. 验收与门禁（每批通用）

1. 四绿门禁：`pnpm typecheck`=0、`pnpm lint`=0err、相关包测试全过、`pnpm architecture:check --changed`=0viol；交互改动补 E2E（滚动/站点权限必带）。
2. **行为一致性对照（1:1 移植项专用）**：本机装有官方 ZCode 3.15.1 作并排基准——同一操作序列两边同测，截图比对布局/文案/交互，后端比对协议字段与状态机终态。
3. **资产固化**：每批开工把该批上游证据（明文资产/解码片段/i18n 键值/SHA256SUMS）入树内 `upstream-assets-3.15.1/`，复刻以固化为准。
4. 移植代码处中文注释「移植自 ZCode 3.15.1 上游 + 依据」。
5. FC 提醒：跑测试前退出 FreeCodeZ app（UDP 53717 撞车）。
6. 流程=四件套：规格书→作业手册→资产固化→实施记录（FC 先例 docs/spec/upstream-fix-port-batches-0-1.md）。

## 10. 执行顺序与树专属裁决

```
U1（5 项止血，立即）→ U2（先出作业手册；U2-1/U2-2/U2-3 可并行）→ U3（U3-0 基座 → U3-1/U3-2 并行 + U3-3/U3-4 穿插）→ P3 飞书（独立决策，不进主线）
```

- **FC 专属**：R1=保留 retune（已裁决 2026-10-13）；工作流状态修复 F2 靠自研面+五条回归收口。
- **quartet 专属**：①先补《上游修复移植五批次指导书》再上本方案；②R1 默认=全照抄上游世代语义；③FC 的 retune/op-log/amend 互斥/actor 门等增强若想要，作为**可选后续移植**（从 FC 树搬，不从上游反编译）；④更新链现状自查后定 F3/U1-5。

## 附：两份 ⚠️ 项的再深挖路径（可选，各约半天）

- F2（工作流状态显示错误）：对 vendored CLI 同源模块（workflow reducer/resume·amend 事件处理）逐函数解码 zcode.cjs 对应区，有机会找到上游修复点升 ✅。

## ⚠️ 2026-10-13 晚增补：orca 底座适配说明（本方案写作时的底座假设已过时）

**事实变化**：本方案写作时假设两树都是 ZCode 衍生 CUA 旧栈（koffi+R19 Helper）。2026-10-13 FreeCodeZ 已完成 orca 完全平替合并（main=904d5742 起，规格书见《规格书-FreeCodeZ-orca合并与3151重放-2026-10-13.md》），U1/U2/U3 移植批已重放到 orca 底座上（零丢失审计通过）。**quartet 若沿用本方案，底座假设需按本节校正。**

对 quartet 的三点影响：

1. **§3 判定矩阵的 CUA 相关行已过时**：矩阵基于旧栈 CLI 树。quartet 若也已切 orca（或计划切），凡涉及 CUA 面的判定（引擎、helper、权限、HUD、卡片渲染）以 orca 分支形态为准重查；若 quartet 仍是旧栈，本方案 CUA 无关批次（U1-1 文件打开、U2-2 滚动、U2-3 会话解码、U2-4 站点权限、U2-5 工作流调参、U2-6 网络、U3-0 沙箱、U3-4 托盘）**不受影响可直接执行**——这些批次在 FC 侧已验证与 CUA 引擎无耦合。
2. **移植来源建议**：quartet 做 U1/U2 时，**直接从 FC 合并后的 main 搬运**（已含全部移植+orca 适配），不从上游反编译重做——FC 的 23 个重叠文件处置表（重放语义）就是现成的移植参考。
3. **重放技术要点（FC 实证）**：若 quartet 走"先 orca 后移植"路线，注意行尾坑（旧线=CRLF、orca 线=LF，补丁重放需 `sed 's/\r$//'` + `git apply --ignore-whitespace`）与 CLI 树 dist 重建坑（tsc 不清孤儿产物，旧 dist 残留已删包的 import 会炸测试，按 contracts→adapters→core→bootstrap→cli/tui/node-repl-host 顺序清后重建）。
- F10（会话加载卡住）：定点解码 zcode.cjs 的 session load/decode 链路（对照树内 CLI 同源模块），有机会找到上游容错实现、消掉 codecs 自研例外。
