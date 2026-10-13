# 升级方案：对齐 ZCode 3.15.1（借鉴反编译源码）

日期：2026-10-12 ｜ 基线：FreeCodeZ 3.14.0 fork ｜ 对照：官方 ZCode 3.14.3 ↔ 3.15.1（本机 /Applications/ZCode.app + Downloads 双 DMG 解包）

## 0. 名词表（先读这个）

| 名词 | 人话解释 |
| --- | --- |
| 交互视图 / Gen UI | AI 回复完成后，在聊天记录里直接显示一个能点的图表/小页面，不用另开文件 |
| UI 插件 / MCP App | 插件不只提供工具，还能在聊天里显示自己的界面（按钮、表单等） |
| 自主模式 / guarded | 「放开跑，但碰到危险命令先问我一次」的权限档位 |
| 留白 / hole | 工作流脚本里留个空位，跑到那里暂停，等主代理补几行代码后原地继续 |
| 站点权限 | 内置浏览器打开的网站想用摄像头/麦克风/定位时，弹窗问你允不允许 |
| 预热 | 启动 App 时提前拉起的 Agent 子进程数量 |
| asar | Electron 应用打包后的代码容器，解包=反编译的第一步 |

## 1. 调查方法（可复现）

- 3.15.1 asar 解包：`/tmp/z3151/app/out`（main/host/renderer/preload/scheduler/plugin-sandbox）；3.14.3：`/tmp/z3143/app/out`（DMG 挂载于 /tmp/z3143-dmg）。CLI 运行时在 asar 之外：`Resources/glm/zcode.cjs`（15MB，双版本对比）。
- 全量重构建导致 chunk 哈希全换（5523 个文件名变化），文件级 diff 无效；改用 **i18n 词表集合 diff**：抽取两版 IntlProvider 中文串对比，得 247 条新增 + 51 条删除词，与更新日志逐条对上号，再以锚词定位 minified 实现区域。
- FreeCodeZ 侧为 TypeScript 源码直查；「fork 前就没有 vs fork 后被删」用基准树 `/Users/homebaby/Desktop/swarm-os/ZCode`（纯净 3.14.0）区分。
- 所有「FreeCodeZ 存在此问题」的断言均经 file:line 复核（关键 6 处已二次抽验）。

## 2. 判定矩阵（总览）

更新日志 15+ 条，剔除 GLM 账号独有（邀请活动/HighSpeed 体验/额度重置入口）后逐条判定：

| # | 更新日志条目 | 上游 3.15.1 | FreeCodeZ 现状 | 判定 | 批次 |
| --- | --- | --- | --- | --- | --- |
| 1 | 自主模式：危险命令先确认 | 新增 guarded 档 | 无 guarded，仅灾难形态 deny 地板 | **缺失，可移植** | U2 |
| 2 | 可视化交互界面（消息流展示） | Gen UI+visualize-plugin | 零基础，协议无预留 | 缺失，可移植 | U3 |
| 3 | UI 插件（MCP App） | plugin-sandbox 新基座 | 零基础 | 缺失，可移植 | U3 |
| 4 | 工作流创建前调参 | 确认卡可改并发/模型 | 确认卡只读 | 部分缺失 | U2 |
| 5 | 工作流运行中改并发 | amendWorkflowRunSettings | **已有**（自研 retune 原地调参，比官方细） | 已具备 | — |
| 6 | 工作流保存复跑 | SaveWorkflow+中枢 | **已有**（含 `~/.freecodez/workflows`） | 已具备 | — |
| 7 | 子代理单独指定模型 | subagent_model | **已有**（create-workflow.ts:168） | 已具备 | — |
| 8 | 飞书群/话题协作 | host 直连开放平台 | 有第一代底座，群/话题增量为零 | 可移植但建议缓 | P3 |
| 9 | 浏览器站点权限管理 | 完整体系（四态+管理页） | **完全没有** | 缺失，可移植 | U1+U2 |
| 10 | Linux 关窗驻留托盘 | DBus 探测+Linux 支持 | win-only | 差距（非 bug） | U3 |
| 11 | 账户菜单复制用户 ID | 账号体系 UI | 去登录 fork，无账户菜单 | 不适用 | — |
| 12 | 修复：加速回合消息丢失 | HighSpeed 专属路径 | 无 HighSpeed；公共路径低风险已知取舍 | 不适用 | — |
| 13 | 修复：工作流状态显示错误 | CLI 侧（不可见） | 自研 retune/op-log 已修同域 | 已覆盖，待回归 | U2 顺带 |
| 14 | 修复：更新失败不复查 | recheckAfterDownload | 更新链已删，自有 checker 带退避 | 不适用 | — |
| 15 | 修复：浏览器权限默认放行 | 显式 allowlist+default-deny | **存在**（无任何 handler=Electron 默认全放行） | **存在，S 级止血** | U1 |
| 16 | 修复：本地文件默认浏览器打开失败 | fileURLToPath→openPath | **存在且更糟**（双重断裂） | **存在** | U1 |
| 17 | 修复：群聊 @提及不准 / 飞书授权过期 | 群体系内部 | 依赖 #8 | 随 #8 | P3 |
| 18 | 修复：窗口 resize 滚动跳动 | 当帧批量重测+单次贴底 | **存在**（等价 3.14.3 旧逻辑） | **存在** | U2 |
| 19 | 修复：异常消息卡会话加载 | CLI 侧产出过滤 | **风险更大**（裸 JSON.parse+无超时） | 存在 | U2 |
| 20 | 修复：Windows 链接启动安全 | 协议注册补 `--` | **存在**（同 3.14.3 漏洞形态） | **存在，5 行** | U1 |
| 21 | 修复：多工作区启动卡顿 | 预热 3→1 | **存在**（LIMIT=3） | **存在，2 行** | U1 |
| 22 | （更新日志未提）资源管理器「网络」标签页：记录本机应用请求 | 新 tab（1000 条上限，按 URL/进程/PID/方法筛） | 有资源管理器（CPU/内存/存储）无网络 tab | **缺失，可移植** | U2-6 |

**一句话总评：6 个 bug 里 4 个在 FreeCodeZ 实锤存在（其中 2 个比上游还糟），新功能里工作流组主体已具备（部分还是自研超前），真正的空白是 Gen UI/插件沙箱/站点权限/guarded 四大块，外加一个更新日志没提的「网络请求观测」新面（第二轮补查发现）。**

## 3. U1 批：立即修复（全部 S 级，已实证）

### U1-1 本地文件「在默认浏览器中打开」双重断裂（比上游更糟）

**现状实证**：
- 工具栏按钮 `UnifiedBrowserView.tsx:917-925` 拿 `webview.getURL()`（file:// 时）→ `desktopMainIpcPlatform.ts:189-194` 的 handler 用 `/^https?:\/\//` 白名单**静默吞掉**（无日志无提示），而 UI 侧 `embeddedBrowserHelpers.ts:131-138` 明确允许 file:，按钮可点但永远无效。
- 本地预览卡 `OpenSplitButton.tsx:174-193` → preload `index.ts:658` 发 `OpenExternalFile` 通道 → **main 侧无任何 handler**（原 handler 随 `desktopMainIpcRemote.ts` 在 commit 8ccf9b9c 被掏成 no-op stub 一并删除）→ invoke 必然 reject → toast「打开失败」。`openPathInDefaultApp`（`desktopMainIpcHelpers.ts:12`）成死代码。

**上游做法**（3.15.1 main@≈709424）：OpenExternal handler 新增分支——`file:` 协议先 `fileURLToPath` 转本地路径，normalize+realpath 后 `shell.openPath`，不再交给 openExternal。

**改法**：① **恢复 `ipcMain.handle(PlatformChannels.OpenExternalFile, …)` 接 `openPathInDefaultApp`**——原始实现已从 git 历史完整找回（`8ccf9b9c~1` 的 desktopMainIpcRemote.ts:309-311，两行：`ipcMain.handle(PlatformChannels.OpenExternalFile, async (_event, rawPath: string) => openPathInDefaultApp(rawPath, options.logger))`；注意该文件现已是 6 行 no-op stub，handler 应恢复到现存 IPC 注册点而非恢复整个文件）；② OpenExternal handler 加 file: 分支走同一条路径（**不要**放宽现有 regex 直接 openExternal，保留 fork 的 http(s) 防御）。
**验收**：内置浏览器打开本地目录站点，工具栏「在默认浏览器中打开」成功唤起 Finder/默认应用；本地网站预览卡点开文件不再报「打开失败」。

### U1-2 Windows 协议注册参数注入

**现状实证**：`desktopOAuthDeepLink.ts:409` `setAsDefaultProtocolClient(scheme, process.execPath, [entry])`、`:426` packaged 裸调用——均无尾部 `--` 分隔符，与 3.14.3 漏洞形态相同（Windows 协议激活时 URL 追加进命令行，缺 `--` 时链接内容可能被 Chromium 当作命令行开关解析）。
**上游做法**（3.15.1 main@≈373022）：win32 下注册命令追加 `"--"`，两分支都改。
**改法**：同款 5 行。**验收**（Windows）：注册表里 `freecodez` 协议命令含 `--`；伪造含 `--`/空格参数的链接不会让 argv 出现额外开关。

### U1-3 多工作区启动卡顿：预热 3→1

**现状实证**：`startupWorkspace.ts:40` `STARTUP_AGENT_WARMUP_LIMIT = 3` + `shared/validation.ts:188` `.max(3)` + `host/index.ts:2518-2524` 并发拉起。冷启动恢复 3 个 workspace 会话时并发起 3 个 agent 子进程。
**上游做法**（3.15.1 main@≈354716）：常量 3→1，协议校验同步 `.max(1)`。
**改法**：常量+schema+`:148-150` 注释三处同步。**验收**：恢复含 3 个本地 workspace 的会话冷启动，只出现 1 个 agent 预热进程，切换到其它 workspace 时按需冷启动。

### U1-4 浏览器权限默认放行止血（完整体系见 U2-4）

**现状实证**：`packages/desktop/src/main/` 全目录 `setPermissionRequestHandler/CheckHandler` **0 命中**（已复核）；内置浏览器 webview 用 `persist:freecodez-embedded-browser` 分区（`BrowserViewportSurface.tsx:151`、`browserDataManager.ts:31`），该 session 无任何权限策略 → **Electron 默认自动批准一切权限请求**（官方安全文档明示的坑）：任意网页静默获得摄像头/麦克风/定位/通知。
**上游做法**（3.15.1 main@≈527158）：allowlist 自动放行 4 项（clipboard-sanitized-write/fullscreen/pointerLock/mediaKeySystem）+ 13 项可询问 + 设备选择器 + **其余一律 default-deny**。
**改法（止血版）**：先装 handler 实现「allowlist + 其余默认拒绝」——哪怕暂时不弹询问（全拒绝），也比静默放行摄像头安全。询问流与管理页归 U2-4。
**验收**：内置浏览器打开任意请求摄像头的网页 → 权限被拒绝（控制台/页面提示），不再静默放行。

### U1-5（顺手清理）preload 死 IPC

`preload/index.ts:818/871` 仍暴露 `downloadUpdate`/`quitAndInstallUpdate`，main 无 handler（调用必 reject）。摘除。

## 4. U2 批：高价值移植（M 级）

### U2-1 自主模式 guarded 档（推荐优先）

**上游机制**（已解明，全部实证）：新增 `guarded` 档 = yolo 语义 + 危险命令单次确认。判定是**纯静态 shell 解析黑名单引擎**（非 LLM）：完整 shell parser（posix/cmd/git-bash 三方言）→ 递归解壳（sudo/env/bash -c/解释器）→ 匹配规则库（ruleId `safety.bash.*`）：`rm -r`/`dd`/`mount`/`mkfs*`/`rsync --delete`/`git reset --hard`/`git clean`/`git push --force`/`git checkout`/`git stash clear`/`rd`/`del`/`find -delete`/`robocopy /MIR`。**尊重用户显式保护 flag**（--dry-run/--no-force 命中即放行）；解析失败/含动态词 → 保守放行不询问（防误杀）。命中 → `ask(..., "user-once")` 复用既有权限面板（仅此一次/始终允许相同命令/拒绝，`suggestedPermissionUpdates` 落规则）。

**FreeCodeZ 现状**：`CollaborationMode` 无 guarded（`session.port.ts:32`、`execution-state.ts:4`、`zcode-protocol/index.ts:3562`、UI `zcodeSessionProjection.ts:25-45`）；现有 = yolo 前置 `findCatastrophicBashCommand` 4 类灾难形态**直接 deny**（`permission/service.ts:139-158`，无逃生）。基础设施齐备：shell 解析器 `bash-command-parser.ts`（276 行）、ask 流、`suggestedPermissionUpdates` 协议字段、**手机端已支持权限应答**（`web-remote-control/core.ts:328`）。

**改法**：① 在 bash-command-parser 之上实现 `matchDangerousCommand`（按上表移植规则库）；② guarded 档贯通 5-6 处 schema+UI+i18n；③ 接入 service.ts（顺序：guarded 命中规则 ask > yolo/guarded 放行）；④ **按 workspace 维度设默认模式：本机默认 guarded、远程/运维 workspace 显式 yolo**——ask 事件经现有 `respond_permission` 推到手机，远端无人值守零打扰（正好吻合「本机保护+远端全权」需求）；⑤ 保留 catastrophicFloor 作为无人确认时的兜底（上游 DenyPermissionBroker 在无 permission client 时 fail-fast 而非静默执行）。
**验收**：本机工作区放开跑，执行 `git reset --hard` 时手机弹确认，点允许才继续、选「始终允许」后同类不再问；远端服务器会话切完全访问，全程零打扰。

### U2-2 窗口 resize 滚动跳动

**上游机制**（已解明）：修复不在滚动守卫（两版逐字一致），在 resize 处理器：旧逻辑（=FreeCodeZ 现状 `ConversationTimeline.tsx:1059-1092`，已复核）ResizeObserver 只观察内容列**宽度**、120ms 去抖 settle 后才贴底——高度变化根本不触发，settle 前的中间态用户可见。新逻辑：observer 同时观察滚动容器（高度变化也触发）；**贴底（following）状态下当帧同步处理**：摘 observer → 置标志禁用全部逐条滚动补偿 → 一次性收集所有已渲染行真实高度 → `flushSync` 批量 resizeItem → 单次 scrollToBottom（校验用户没上滚）→ rAF 后重挂 observer。
**改法**：单文件 ~100 行，按机制移植（注意防 observer 自激）。**验收**：长会话贴底时拖拽窗口四角，视图不跳、始终贴底；上滚后再缩放窗口，阅读位置不漂移。

### U2-3 会话加载健壮性（自有加固，3.15.1 原修复在 CLI 不可 cherry-pick）

**现状实证**（比 3.14.3 基线更裸）：① CLI 存储解码裸 `JSON.parse` 无 try/catch——`apps/zcode-cli/packages/adapters/src/storage/session-store/codecs.ts:84/117/159`（decodeMessageRow/decodePartRow/decodeSessionEntryRow 三处，已复核确认不在 try 内）+ `repositories/messages.ts:246-256` 调用点，一条坏 part 整个会话读取抛错；② `conversationProjectionStore.ts` 的 `awaitingInitial`（:294, :457-476）**无兜底超时**，initial 帧若因坏消息在产出侧构建失败，UI 无限转圈（正是「卡住」形态）；③ 无 contentRejected 富故障码语义（3.14.3 已有、fork 基线 3.14.0 没有）。
**上游机制（第三轮已解明，规格级）**：
- contentRejected：16 个 assembler 故障码 FC 的 wire-assembler **已全有**（含唯一被判 contentFault 的 `proto.frameAssemblyInvalidPayload`）；缺的是 store 层语义。contentRejected 是 renderer store 本地派生的终态码（非 wire 事件），UI 在 SessionSubscriptionErrorPanel 原样显示，**无需新 i18n**。移植落点：`conversationProjectionStore.ts` 六点（recovery 类型加 contentFault / handleAssemblyFault 判 InvalidPayload 走 requestRecovery(true,{contentFault}) / failRecovery 升级 `fault.subscription.contentRejected` / 超时分支显式 contentEligible:false）+ `sessionsIndexStore.ts` 同款六点（升级时**额外停用自动重试**）+ 可选 shared 导出 `isContentAssemblyFaultReason` 守卫。transport/decoder 的 reasonCode 通道现成。
- elide 家族归属【已确认，修正第二轮推测】：= `session/read` RPC 的 `contentProfile:"index"` 出口裁剪，唯一消费者是桌面 services 层 task-index 回源同步（FC 对位 `zcodeTaskIndexSyncer.resyncTaskIndexRowFromAgent:501-531`）。只削合法巨型载荷（reasoning 文本/data: URL/tool 输出），**不修坏数据解析**；与「对话打开卡住」无关，定位为「会话列表性能加固」，与坏行容错互补。若移植四处：shared `zcodeSessionReadParamsSchema` 加 contentProfile（index.ts:1676-1683）/ server-operations readSession 解析+elide（:1841-1852）/ zcodeAgentService 透传（:3218-3225）/ syncer 回源带 index profile（:514-517）。
**改法**：① codecs/messages 解码加 per-row try/catch+告警跳过（隔离坏行，坏行缺失可接受，整会话打不开不可接受）；② awaitingInitial 加兜底超时转 error 态；③ contentRejected 语义按上述规格移植；④（可选后置）索引削重 elide。**验收**：手工往 session DB 写一行非法 JSON + 一条含超大 data: URL 的消息，会话仍能打开（坏行缺失或标注），绝不无限转圈；坏帧走 forceSnapshot 再失败后错误条显示 `fault.subscription.contentRejected`。

### U2-4 站点权限完整体系（U1-4 之上）

**上游机制**（已解明）：持久化 `<userData>/embedded-browser-site-permissions.json`（origin×permission，allow/deny，原子写）；决策顺序=持久设置→本次运行 session-allow→UI 询问（20 秒超时=拒绝）；四态（始终允许/仅本次/阻止/不允许）；管理页 13 项权限三态下拉+重置，挂在侧栏 `browser-permissions` tab；IPC 六个通道。
**改法**：照抄架构（shared 通道+IPlatformService 类型、main 策略/存储模块、preload 桥接、UI 三件），默认策略照抄上游。**验收**：网站请求摄像头弹「{origin} 想要使用摄像头」卡，选「仅本次」当次可用刷新再问；管理页改「允许」后不再问；20 秒不操作自动拒绝。

### U2-5 工作流：创建前调参 + 模式设置三态 + 状态回归

FreeCodeZ 工作流组主体已具备（运行中改并发/保存复跑/子代理模型/增量 op-log 都是现成的，retune 还是自研超前；第三轮已逐条验真，见 §10-A）。缺三件：① 确认卡从只读（`packages/ui/src/WorkflowPermissionBlock.tsx`，读 maxConcurrency/subagentModel 仅展示）升级为可调（并发上限三态+子代理模型选择，确认时并入 CreateWorkflow 载荷，协议无新消息）；② **dynamicWorkflowMode 用户设置三态**——注意 FC 已有 env 灰度层（`desktopRuntimeEnv.ts:529-535` resolveDynamicWorkflowModeHostEnv，Main 决策、production 删继承值），缺的只是用户设置键+设置页，移植=设置键优先+env 兜底，不是从零加键；③ 顺带做「resume/amend 后 run 状态一致性」回归（对齐官方修复场景 #13，FC 自研 retune/op-log/amend 互斥已覆盖同域，以运行时回归验证收口；第三轮锚点对比确认状态模型两版逐字一致、精确修复点未行级定位，回归场景建议五条见 §10-G）。
**验收**：确认前直接把并发调成 4 并指定子代理用别的模型，起跑即生效；「自动化 › 工作流」按名字复跑可再调参。

### U2-6 资源管理器「网络」标签页（更新日志未提，第二轮补查发现；与「外发治理」愿景直接相关）

**上游机制**：资源管理器（已有 CPU/内存/存储 tab）新增「网络」tab——记录本机应用请求，最多保留最近 1,000 条（超出按序淘汰，UI 显示「{count} 条 · 已淘汰或丢弃 {dropped} 条」），列=时间/URL/进程/PID/方法，支持筛选与清空、分页。数据链路两条：CLI 侧 `createNodeNetworkCapture` 用 `node:diagnostics_channel`（undici/http.request）捕获 agent 进程网络请求（含 `withoutNetworkCapture` 静默逃生）；main 侧新增 `NetworkCapture` 与 `zcode:get-network-capture-snapshot`/`zcode:clear-network-capture` 通道（3.14.3 preload 无此二通道）。相关：`RequestObservationStore`（按 x-request-id 记 64 条观测，请求签名/诊断用）。
**FreeCodeZ 现状**：资源管理器已有（`packages/shared/src/channels.ts:267-282`：CPU/内存快照+存储扫描/清理五通道），网络 tab 与 network-capture 通道**零命中**【已确认】。
**判定**：这不是普通功能对齐——它是「外发治理」（AI 中枢四大功能之一）的**观测层雏形**：记录应用往哪里发了什么请求。FC 要做外发治理，这里既是上游借鉴点又是最短路径。
**改法（第三轮已拿到规格级四层方案）**：
- **语义总纲**：window-scoped——开资源管理器窗口才点亮采集（captureId=randomUUID），关窗/崩溃即停并清零不留痕；「清空」= captureId 全局轮换。
- **采集三源**：① Electron `session.webRequest.onBeforeRequest`（defaultSession + 自定义 partition，http(s)/ws(s)，需用合并订阅器——Electron 单监听器限制，排除内嵌浏览器 guest）；② main 自身 Node 出网（diagnostics_channel undici/http）；③ host/CLI 转发（CLI 经 `process/networkRequests` JSON-RPC 通知 → host `LocalRuntimeNetworkCapture` 补 pid → `network-capture-batch` 端口消息回 main）。每进程 100 条/250ms 批量，main 端 1000 条环形缓冲+dropped 计数。
- **记录 6 字段**：`{id, timestamp, processType(main|host|renderer|cli), pid, method(≤32), url(≤2048)}`——只有请求方向元数据，无状态码/字节数。
- **脱敏（不可打折）**：四进程边界统一 `sanitizeNetworkCaptureUrl`（建议 FC 放 shared 单点，上游是四处副本）：query 值全 `[redacted]`（键保留）、userinfo 凭据删除、hash 删除、非 http(s)/ws(s) 丢弃、2048 截断；MCP OAuth/官方 auth 流量用 AsyncLocalStorage 整体排除。残余面：路径与主机名原样保留。
- **UI**：500ms 轮询（无推送）、每页 100、时间/进程PID/方法/URL 四列、单文本框过滤、空态两态；i18n 13 键（resourceManager.network.*）。
- **FC 落位**：`channels.ts` 两通道 + Host 消息两型 → 新建 `packages/shared/src/networkCapture.ts`（类型+zod+脱敏单点）→ main 新建 `resourceManagerNetwork.ts`（对标 resourceManagerStorage.ts；生命周期挂 openResourceManager，鉴权复用窗口 webContents.id 模式）→ host 侧 `zcodeAgentProcessManager` spawn 后 register → CLI 侧 vendored 0.16.9 **无任何 capture 代码需一并移植**（或首期裁剪为 main/host/renderer 三源，上游架构支持按源裁剪）→ preload 桥 + `NetworkSection.tsx` + i18n。
**验收**：开着资源管理器跑一段对话，网络 tab 实时出现到模型 API/内置浏览器的请求记录（query 值显示 [redacted]），按 URL/进程筛选有效；清空后计数归零；关窗再开列表为空。

## 5. U3 批：大功能（按需排期，先立 spec 再动手）

按 AGENTS.md，这批属「新增行为」，实施前需先写对应 spec。**执行依赖：U3-1 与 U3-2 共用 plugin-sandbox 沙箱基座，基座（事实上的 U3-0）先行落地，两个消费方再并行**；U3-3 留白与 U3-4 托盘无依赖可穿插。

### U3-1 Gen UI 交互视图（工作量 M + 沙箱基座 S-M）

上游机制：agent 按 visualize skill 规范写 HTML fragment 到会话级目录（host 给 `ZCODE_GEN_UI_OUTPUT_ROOT`，scope key=`[workspaceIdentity||path, sessionId]` 与 FreeCodeZ 身份规则一致）→ 完成的消息正文独占一行 `::visualize{"path":...}` 文本引用 → renderer 解析切段、消息流内联挂沙箱卡片。widget 桥仅 4 个 API（widgetState≤16KiB/setWidgetState/sendFollowUpMessage/openExternal），follow-up 需确认（「来自交互视图」归因），vendor 资源本地拦截解析。
**红线**：FreeCodeZ 在 `WorkflowArtifactBody.tsx:32` 有书面安全决策「刻意不做 iframe：renderer 无 CSP，allow-scripts+allow-same-origin 等价逃逸」——**必须完整移植上游双隔离基座（特权协议+专用 preload 的 webview+内层 sandboxed iframe），不可降级为直接 iframe**。

### U3-2 UI 插件 MCP App（M-L + 同基座）

上游机制：MCP server 在 resource 注解声明 `ui` 对象（兼容 Codex 风格 `openai/widget*` 回退键）→ host 把插件 HTML 重发布到 `zcode-sandbox://` 协议 → 双隔离加载 → `ui/*` RPC（message/update-model-context/callTool…）→ 「插件想以你的身份发送消息」**强制可编辑确认对话框**（钓鱼面，不可静默）→ App Tools 反向通道。与 U3-1 共用 plugin-sandbox 基座（① 是硬前置）。

### U3-3 工作流留白（hole）体系（L，引擎级新原语）

上游：脚本 `hole()` 挂起 + `FillWorkflowHole` 工具 + run 状态机 holes 字段 + 补全重放 + skill §15 作者契约。FreeCodeZ 全链路 0 命中。需动 CLI 引擎+shared v4 wire schema+UI 工具卡+skill 文档，且**必须同时验证 desktop-continuous 实时链路和 web-remote-replayable 恢复链路**。价值：复杂工作流可「跑到一半等确认再继续」，与用户的审批面需求同向，但成本最高，建议留白需求出现后再排。

### U3-4 Linux 托盘驻留（M-L）

FreeCodeZ 发 Linux 包（AppImage/deb/rpm/pacman），有实际意义。上游改动面：DBus StatusNotifierWatcher 三工具探测（gdbus/busctl/qdbus）+能力监视器+设置迁移字段+IPC+三态 UI（含 GNOME 提示）+图标路径。改动约 8-10 文件。

## 6. 不适用 / 缓办清单（如实说明）

| 条目 | 原因 |
| --- | --- |
| 更新失败不复查 | fork 已删 electron-updater 整链（`index.ts:87-104` no-op、builder 无 publish），自有 `updateChecker.ts:99-101,247-258` 已带失败退避复查。仅顺手清理死 IPC（U1-5） |
| 加速回合消息丢失 | HighSpeed 为 GLM 账号功能；公共路径（CommandInbox 持久队列+删除-恢复式编辑）风险低且是有意设计取舍（`SessionPane.tsx:3191-3204`） |
| 账户菜单/复制用户 ID | 去登录 fork，无账户菜单（`user?.id` 仅遥测用） |
| 飞书群/话题/@提及/授权过期（P3） | **调查纠正了预设：不强绑官方云**（桌面 host 直连 open.feishu.cn+WebSocket 长连接+凭据本地存），FreeCodeZ 已有第一代底座（`feishuProvider.ts` 787 行）。但群/话题增量是 L 级，且与自研 LAN relay 方向正交——除非明确要「在飞书群里 @机器人派活、同事在话题里跟进」，否则不进主线，留作独立决策 |

## 7. 实施顺序与门禁

```
U1（止血批，全部 S 级）→ U2（U2-1 guarded 与 U2-2/3 可并行）→ U3（先 spec 后实施）
```

- 每批完成门禁按仓库规矩：`pnpm typecheck`=0、`pnpm lint`=0err、相关包测试全过、`pnpm architecture:check --changed`=0viol；交互改动补 E2E（U2-2/U2-4 必带）。
- **行为一致性对照验收（1:1 移植项专用）**：本机装有官方 ZCode 3.15.1，直接作为并排对照基准——同一操作序列两边同测，截图比对布局/文案/交互，后端比对协议字段与状态机终态。
- **上游资产固化**：每批开工时把该批用到的上游证据（明文资产、解码片段、i18n 键值表、SHA256SUMS）入 `upstream-assets-3.15.1/` 固化入库，复刻以固化为准、不以 /tmp 解包树为准。
- 移植类改动在代码处用中文注释注明「移植自 ZCode 3.15.1 上游机制 + 依据」。
- 跑测试前退出 FreeCodeZ app（UDP 53717 撞车，历史坑）。
- 双版解包产物在 /tmp（重启即失），如需复查按 §1 方法重做即可。

## 8. 关键证据索引（file:line 速查）

| 断言 | 证据 |
| --- | --- |
| 预热=3 | `packages/desktop/src/main/startupWorkspace.ts:40`、`packages/shared/src/validation.ts:188` |
| 协议无 `--` | `packages/desktop/src/main/desktopOAuthDeepLink.ts:409,426` |
| 无权限 handler | `packages/desktop/src/main/` 全目录 grep 0 命中（复核） |
| OpenExternalFile 断链 | `packages/desktop/src/preload/index.ts:658`（发送端）；main 无 handler（复核）；stub 删于 8ccf9b9c |
| file:// 被吞 | `packages/desktop/src/main/desktopMainIpcPlatform.ts:189-194` vs `packages/ui/src/embeddedBrowserHelpers.ts:131-138` |
| 滚动旧逻辑 | `packages/ui/src/v4/ConversationTimeline.tsx:103,1059-1092`（复核） |
| 裸 JSON.parse | `apps/zcode-cli/packages/adapters/src/storage/session-store/codecs.ts`、`repositories/messages.ts:246-256`（路径已复核修正） |
| 无 guarded | `apps/zcode-cli/packages/contracts/src/interfaces/session.port.ts:32`、`packages/shared/src/execution-state.ts:4`、`zcode-protocol/index.ts:3562`、`packages/ui/src/lib/zcodeSessionProjection.ts:25-45` |
| 灾难地板 deny | `apps/zcode-cli/packages/core/src/permission/service.ts:139-158`、`bash-catastrophic-policy.ts:15-38` |
| 工作流已有面 | `create-workflow.ts:163,168`、`workflow-run-settings-command.ts`（retune 自研）、`settings/saved-workflows/`、`workflow-runs-delta`（git bb6c6183/dcc2cd9c/6ad4c691） |
| iframe 红线 | `packages/ui/src/app-shell/workflow-artifacts/WorkflowArtifactBody.tsx:32` |
| 更新链已删 | `packages/desktop/src/main/index.ts:87-104`、`electron-builder.config.js:864,493-494` |
| 飞书第一代 | `packages/services/src/bots/providers/feishuProvider.ts`（787 行）、`runtimes/feishuRuntime.ts:101` |

上游 minified 证据（偏移）在各调查报告正文中：危险命令引擎 zcode.cjs@7359439/7439615/5210104；滚动修复 renderer styles@3426297；站点权限 main@527158/742108；托盘 main@573518-577500；预热 main@354716；协议注册 main@373022；file 打开 main@709424；hole 引擎 zcode.cjs@7799972/1468239；网络捕获 zcode.cjs@507704（diagnostics_channel）+ RequestObservationStore@3793735；elide 三函数 zcode.cjs@913963。

## 9. 补查记录（第二轮复查，2026-10-12）

首轮交付后按「完整性」标准二次复查，手段：zcode.cjs 双版**函数名集合 diff**（esbuild `s(fn,"原名")` 注解，414 个新增真实函数名，逐个分类）+ preload IPC 通道名 diff + Resources 全树 diff + FC 死 UI 排查。结论：

1. **发现一个遗漏功能（已入矩阵 #22 / U2-6）**：资源管理器「网络」标签页（网络请求记录，1000 条环形缓冲，URL/进程/PID/方法筛选）。更新日志未提，但 i18n（`resourceManager.network.*` 全新键）+ CLI 函数（`RequestObservationStore`/`createNodeNetworkCapture`，3.14.3 零命中）+ preload 通道（`get/clear-network-capture`）三重证据实锤。FC 有资源管理器无网络 tab。与「外发治理」愿景直接相关，建议按 U2-6 落地。
2. **「异常消息卡加载」修复落点缩小**：新增 `elideMessageForIndex`/`elidePartForIndex`/`elideSessionSnapshotForIndex`（3.15.1 独有）=建索引前剥空文本/工具载荷、data: URL 归一，是「异常重内容拖垮加载」的候选修复机制【推测】；`recoveredCompactTimelineCount`/`recoveredSteerInputCount` 两版一致（非落点）；`duplicateMessage` 属留白诊断文案（hole 重复/ID 冲突/晚绑定报错），非会话修复。U2-3 已补入。
3. **preload 通道 diff 全景核对**：新增 14 个通道全部归属已判定功能（站点权限 6 个、plugin-sandbox 5 个、托盘能力 1 个、网络捕获 2 个），无第六个功能组遗漏；仅 `zcode:materialize-workflow-artifact-file` 为产物「作为文件打开」小功能（main `materializeWorkflowArtifactFile`），归入 U1-1 验收面（同一条本地打开链路）。
4. **函数名 414 个分类闭环**：hole/工作流家族、McpUi 家族（MCP App）、GenUi 家族、guarded 权限家族（`applyGrantedPermissionUpdates`/`matchDangerousCommand` 等）、网络捕获家族、工作流子代理模型绑定（`bindScriptModels`/`WorkflowActorModelUnboundError`，佐证 #7 已有面的校验层）、飞书群家族、官方账号 OAuth 家族（GLM 独有，排除）——无未知大块。
5. **Resources 层 diff**：cua-helper 二进制更新（FC 已用 orca 引擎替代，不适用）；glm/packages 内 browser-use/动态工作流 SKILL/documents/presentations/spreadsheets/node-repl-host(+3KB)/zcode-cua/zcode-guide 文档与小版本更新（FC 自有技能体系，按需对照不强制跟）；tools/{bfs,ripgrep,ugrep} 二进制更新并补 SOURCES.json/THIRD-PARTY-NOTICES.txt、新增 licenses/ 目录（合规文本补齐，FC P10 品牌合规可参照做法）；`visualize-plugin` 新增（已入 U3-1）。
6. **FC 死 UI 排查**：旧多供应商模式文案（只读/静默/全权限/自动模式）在 FC i18n **零残留**（干净）；「套餐」相关文案（`startPlan.recommendation`/`purchase.entry`）是**活链路**（useStartPlanRecommendation.ts 在用），非死 UI，与 3.15.1「账户菜单看套餐」不同源，无需动作；账户菜单/复制用户 ID 仍判不适用。
7. **证据闭环补强**：`codecs.ts` 三处裸 JSON.parse 精确到行（:84/:117/:159，确认不在 try 内）；elide/网络捕获/工作流状态修复的定位情况如实标注【推测】与「未能实证」，不编造。

复查后判定矩阵共 22 行，覆盖更新日志全部 23 条（3 条 GLM 账号独有明示排除）+ 1 条未列新功能。方案主体不变：U1 止血批（5 项）→ U2 批（6 项）→ U3 批（4 项）。

## 10. 第三轮排查记录（2026-10-12/13：「已存在内容」验真 + 悬案补齐）

第三轮目标：复核矩阵「已具备/已覆盖」判定是否属实（防误判）+ 把第二轮遗留的悬案调研到规格级。手段：FC 源码逐条验真、git 考古、minified 锚点对比、两路后台深挖（工作流状态修复一路因账号限额中断，本人接手收口）。

### A. FC「已具备/已覆盖」逐条验真——全部成立，两处精确化

| 矩阵条目 | 验真证据 |
| --- | --- |
| #7 子代理指定模型 | `apps/zcode-cli/.../create-workflow.ts:163-172`：max_concurrency 已 clamp、subagent_model 已解析规范形（含「字段在场=显式选过模型」的设计注释） |
| #5 运行中改并发 | `WorkflowRunSettingsPopover.tsx:181-183`（retune 分支）+ `shared/zcode-protocol-v4/workflow-run-settings-command.ts:34-43`（retuned 块：同 runId 不换卡不跟随，防自跟随环） |
| #6 保存复跑 | UI 侧 `packages/ui/src/settings/saved-workflows/` 11 组件；CLI 侧 `saved-workflows/store.ts:53`（项目档 `.zcode/workflows/` + 全局档 `~/.freecodez/workflows/`） |
| #13 自研覆盖面 | 三个 commit 实存：bb6c6183（op-log 增量协议，对照官方 3.14.3 反编译）、dcc2cd9c（amend 互斥+escalation 挂死修复）、6ad4c691（actor 数量门+工具白名单） |
| guarded 缺失 | contracts/shared 全仓 0 命中（再确认） |

精确化：① U2-5② FC 有 env 灰度层（`desktopRuntimeEnv.ts:529-535`）非「只有服务端灰度」，缺的是用户设置键；② `WorkflowPermissionBlock.tsx` 实际在 `packages/ui/src/` 根下（第二轮路径有误），只读判定成立，另有 `SaveWorkflowPermissionBlock.tsx`。

### B. git 考古：U1-1 被删 handler 原始实现已找回

`git show 8ccf9b9c~1:...desktopMainIpcRemote.ts` 第 309-311 行两行 handler（见 U1-1 改法）。该文件现为 6 行 no-op stub（ARMS RUM 删除遗留），恢复目标是 handler 本身、挂到现存 IPC 注册点。

### C. spec 先例发现：上游移植已有四件套模式

`docs/spec/upstream-fix-port-batches-0-1.md`（批次 0/1 实施记录）+ `作业手册-FreeCodeZ-上游修复移植.md` + `upstream-assets-3.14.3/`（SHA256SUMS.txt + dynamic-workflows 三件套 + reconstruction/）。**U1/U2 批应沿用该模式**：规格书 → 作业手册 → 资产固化（上游证据入 upstream-assets）→ 实施记录。另：批次 1 已把 dynamic-workflows SKILL 升到 0.3.0（基于官方 3.14.3），**U3-3 留白移植时 SKILL §15 要基于该底座再升**，不是从旧版直接跳。

### D. contentRejected 移植规格（已入 U2-3）

16 故障码 FC 已全有，缺 store 层语义；两个 store 各六点 + index 版停自动重试；renderer 本地派生终态码，无新 i18n；超时路径 contentEligible:false。

### E. elide 归属修正（修正 §9-2 的推测）

【已确认】elide 三函数 = `session/read` 的 `contentProfile:"index"` 出口裁剪，唯一消费者 = 桌面 task-index 回源同步（FC 对位 `zcodeTaskIndexSyncer.resyncTaskIndexRowFromAgent`）；只削合法巨型载荷、不修坏数据解析；与「对话打开卡住」关联中低。定位改为「会话列表性能加固」，与 U2-3 坏行容错互补（四处落点见 U2-3）。

### F. U2-6 网络标签页移植规格（已入 U2-6，规格级）

四层方案+脱敏红线+FC 八步落位；vendored CLI 0.16.9 无 capture 代码需一并移植或首期裁三源。

### G. 工作流状态修复（#13）定位结论——诚实收口

三度尝试（一轮子代理未定位 + 三轮子代理限额中断 + 本人两轮锚点对比）：**状态模型两版逐字一致**（status 枚举 completed/errored/pending/running/stopped、supersededBy/stopReason/resumedFrom/resumable 字段、「stopped 且未被取代才算活动」谓词 3.14.3 已有，i18n card.superseded 两版同在）；该域 3.15.1 可见增量是 settings-run 血统解析（`settings-` 前缀链回溯，对应「按调整后的设置运行」功能）与 holes 状态。精确修复点未行级定位（大概率在 resume/amend 事件的 reducer 状态计算细节）。**维持「回归收口」安排**，建议五条回归断言：① resume 一个 stopped run → 列表与详情状态一致、取代关系正确；② amend 在途被拒（amend_in_flight）→ 卡片不残留在途态；③ 只改并发 retune → 同卡不重开、状态不闪变；④ 已取代的 stopped run 不再显示为可调/活动；⑤ settings-血统 run 的图/label 沿链解析正确（3.15.1 新逻辑，FC 暂无）。

### H. 三轮总结判定

矩阵 22 行经三轮复核无一被推翻；「已具备」四条全部验真；U1-1 恢复代码、U2-3/U2-6 移植规格、U2-5② 精确化、spec 四件套模式、SKILL 底座提醒、#13 回归五断言全部补齐。执行就绪度：U1 批可直接开工（含找回的代码），U2-3/U2-6 已到规格级，U2-5② 修正了实施前提，U3 批维持「先 spec 后实施」。

## 11. 完整移植策略（2026-10-13 用户裁决：能完整抄袭的尽量完整抄袭）

**裁决**：不是「发现功能后做一个类似的」，而是把上游**前端界面+后端逻辑原样搬过来**，只允许在最小改名面上做替换。本节取代前文各处「借鉴机制/自有实现/按 FC 架构落位」的表述——一律以本节为准。

### 11.1 上游源码恢复能力盘点（已查实，四条路全探）

| 路径 | 结果 |
| --- | --- |
| sourcemap | **无**（out 全目录无 .map，main/index.js 与 zcode.cjs 尾部无 sourceMappingURL） |
| asar 内 node_modules 自家包 | 无 @zcode/* scoped 包（全第三方依赖） |
| 官方 npm | @zcode/shared Not Found，不公开发布 |
| 基准树来源 | ~/Desktop/swarm-os/ZCode（3.14.0 源码）无 git/仓库信息，仅此一份 |

**结论**：上游唯一形态 = minified 产物 + 明文资产。但「完整抄袭」可行——**同源反编译移植**：FC 是 3.14.0 同库 fork，上游 minified 带 esbuild `s(fn,"原名")` 真实函数名注解，可与 FC 源码逐模块对照。**仓库先例**：`workflow-runs-delta.ts`（bb6c6183）即「对照官方 3.14.3 逐函数反编译」的完整移植产物，方法已验证。

### 11.2 完整移植管线（三条通道 + 一个底线）

1. **明文资产通道（逐字复制）**：`Resources/glm/packages/*` 全部是明文——visualize-plugin 全套（SKILL/assets/scripts/widgets/references/tweak.md）、dynamic-workflows SKILL §15、各插件 docs。直接复制入 `upstream-assets-3.15.1/` 固化后搬运。
2. **同源反编译通道（上游 diff → TS 补丁）**：上游 minified 函数 ↔ FC 同源源码对照，把 3.15.1 逻辑差异翻译成 TS 补丁贴回 FC 对应文件；UI 从 renderer chunk 解码 JSX 结构+类名+交互+文案键，按 FC 同源组件逐块替换。适用于：滚动修复（ConversationTimeline.tsx）、guarded（permission service）、contentRejected（两个 store）、确认卡调参（WorkflowPermissionBlock）、Linux 托盘（desktopTray/close 判定）。
3. **新增模块通道（1:1 重建）**：3.15.1 全新文件（plugin-sandbox 基座、站点权限 policy/store、network capture、GenUI service）按上游结构/命名/状态机解码为独立 TS 模块，不做「FC 风格重构」。
4. **唯一允许的偏差=最小改名面**：品牌串（用户可见文案 ZCode→FreeCodeZ，P10 规则）、家目录 `~/.zcode`→`~/.freecodez`、partition/env 双写既有约定、账号链引用删除、IPC 通道名沿用 FC 现状。**其余一切（布局、交互、状态机、协议字段、文案措辞）与上游保持一致**。

**并存的自研增强清单（不因「与上游一致」而拆除，属既成事实的 FC 优势面）**：retune 原地调参（同 runId 不换卡）、amend 互斥/amend_in_flight、workflow-runs 增量 op-log、actor 数量门+工具白名单、catastrophicFloor 灾难地板、workspace 维度默认模式（本机 guarded/远端 yolo）。这些与上游机制并存不冲突，新移植代码不绕开它们。

**裁决点 R1——已裁决（2026-10-13 用户拍板：保持现状，保留 retune）**。事实基础（读码修正，非两套互斥实现）：FC 的 `amendWorkflowRunSettings` **主路径与上游世代语义同构**（改设置→新 run、`toolCallId=settings-<uuid>`、`supersededRunId` 在旧 run 被停下时在场、跟随+0-1 防自跟随环守卫，见 workflow-run-settings-command.ts:30-46）；retune 是主路径之上的**窄特例**：仅「只改并发上限且 run 仍在跑」时同 runId 原地生效（`retuned` 块记录新值/前值/天花板，进 op-log 可回溯）。语义依据：并发是**调度旋钮**而非运行定义——不中断在飞 actor、零换卡（K8s 调副本数不重建 Pod 同理）；上游为拧旋钮要停旧 run、开新世代、走跟随链，重且有中断面；世代跟随机制本身有 bug 面（0-1 防自跟随环就是修的这类）。**落地口径**：U2-5 移植 3.15.1 设置族功能时，「并发-only 调整」保留 retune 语义不改造；历史呈现差距（调整埋在事件流、不在 run 列表）列为可选 UI 后补项（run 卡显示设置变更时间线），不动引擎语义。

### 11.3 逐项策略修订（相对前文的变化）

| 项 | 原策略 | 修订后（完整移植） |
| --- | --- | --- |
| U1-1/2/3/5 | 已是代码级 | 不变（代码已找回/行级 diff 已拿到） |
| U1-4+U2-4 站点权限 | 「按 FC 架构落位」 | **上游实现 1:1 移植**：policy/store/prompt 卡/管理页四模块按上游结构建 TS；13 项权限名与四态文案逐条抄 |
| U2-1 guarded | 「按上游规则表自研引擎」 | **引擎完整移植**：matchDangerousCommand 三方言解析+规则表+--dry-run 尊重逻辑逐条搬进同源 permission service；档位枚举与文案照抄（自主模式/在有风险时询问） |
| U2-2 滚动 | 「按机制移植」 | 3.15.1 resize 处理器逐块移植进同源 ConversationTimeline.tsx（flushSync 批量重测/单次贴底/防自激全保留） |
| U2-3 | contentRejected 已是上游移植；codecs 容错「自有加固」 | contentRejected/elide 照抄；codecs 坏行容错若上游无可解码实现则此一小点自研（**唯一允许的例外**，需在作业手册标注） |
| U2-5 | 「确认卡升级为可调」 | 控件与文案照抄 3.15.1（chat.permission.workflow.settings.* 全键），dynamicWorkflowMode 键+设置页三态照抄 |
| U2-6 网络标签页 | 「CLI 可后置/首期裁三源」 | **完整管线照抄，含 CLI createNodeNetworkCapture 移植进 vendored CLI**（不再裁剪） |
| U3-1/2 GenUI/MCP App | 「按 v4 风格重写 schema」 | plugin-sandbox 基座+GenUI+MCP UI 全量移植；schema 按上游形状解码（FC v4 分叉处对照适配）；visualize-plugin 明文整套复制；沙箱双隔离红线保持 |
| U3-3 holes | 「可借鉴」 | 引擎+FillWorkflowHole+holes 状态机+SKILL §15 全量移植（SKILL 基于 FC 0.3.0 底座升） |
| U3-4 托盘 | 「按需移植」 | 探测三命令+能力监视器+迁移字段+三态 UI 照抄 |
| P3 飞书 | 缓办 | 若启动同样完整移植（host 直连方案原样，含 authorizationId 一致性修复与话题归档） |

### 11.4 作业模式与「深挖」的定义

每批开工前先出**作业手册**（沿用四件套：规格书→作业手册→`upstream-assets-3.15.1/` 资产固化→实施记录）。「深挖」的产出=作业手册章节，每项包含：①上游实现全解（minified 锚点 + 解码后的逻辑/UI 结构描述，前端到类名与文案键、后端到状态机与协议字段）；②FC 落点文件清单与逐文件改动；③改名面替换表；④行为一致性验收用例（同一操作序列下与上游表现一致，含文案/布局/交互细节）。U2-4/U2-1/U2-6 三项三轮调查已解码到规格级，各差「UI 组件块级解码」一步即可成手册；U3 两项解码量最大，作业手册先行。

## 12. 逐项 1:1 复刻判定表（2026-10-13 第四轮，应「逐个调研」要求）

前置校验：DMG（/Users/homebaby/Downloads/ZCode-3.15.1-mac-arm64.dmg）内 ZCode.app 与装机版 **app.asar、zcode.cjs 逐字节一致**（cmp 通过）——本表全部结论基于该 DMG 内容的四轮反编译证据。判定口径：✅=可 1:1（仅最小改名面）；⚠️=部分 1:1（原因注明）；❌=不复刻（原因注明）。

### 新功能 9 项

| # | 条目 | 上游实现方式（证据锚点） | 判定 | 复刻路径 |
| --- | --- | --- | --- | --- |
| N1 | 自主模式危险确认 | CLI 新增 guarded 档=yolo+`matchDangerousCommand`（三方言 shell 解析→解壳→规则表 `safety.bash.*`：rm -r/dd/mount/mkfs/rsync --delete/git reset --hard·clean·push --force·checkout·stash clear/rd/del/find -delete/robocopy /MIR；尊重 --dry-run/--no-force；解析失败保守放行），命中→ask(user-once) 复用权限面板（zcode.cjs@7359439/7439615/5210104） | ✅ | 引擎逐条搬进 FC 同源 permission service；档位 5-6 处 schema 贯通；文案照抄（U2-1） |
| N2 | 可视化交互界面 | agent 按 visualize skill 写 HTML fragment→会话目录（`ZCODE_GEN_UI_OUTPUT_ROOT`/visualizations）→正文行 `::visualize{json}` 引用→renderer 解析切段内联沙箱卡（240px→10000px）；桥 4 API（widgetState/setWidgetState/sendFollowUpMessage/openExternal）；web 端降级提示 | ✅ | 依赖 plugin-sandbox 基座先行；skill+资产明文整套复制；input.source.genUi 按 FC v4 适配（U3-1） |
| N3 | UI 插件 MCP App | MCP resource 注解 ui 对象（兼容 Codex openai/widget* 键）→main `zcode-sandbox://` 特权协议重发布+per-app 持久 partition→webview（专用 preload）+内层 sandboxed iframe 双隔离→ui/* RPC+registerAppTools 反向通道；替用户发消息强制可编辑确认框（main@373022 区域/plugin-sandbox 目录） | ✅ | 工作量最大项；协议形状按上游解码、FC v4 分叉处对照；沙箱双隔离红线不可降级（U3-2） |
| N4 | 工作流调参/改并发/复跑 | 确认卡 limit/model 控件（`chat.permission.workflow.settings.*`）确认时并入载荷；`amendWorkflowRunSettings` 运行中改；SaveWorkflow→`.zcode/workflows/`+全局；复跑按名带参 | ✅ | FC 已有改并发（retune 自研超前）与复跑；照抄创建前调参+dynamicWorkflowMode 三态（U2-5） |
| N5 | 子代理单独模型 | `subagent_model` 贯通 create/amend+actor 绑定校验（bindScriptModels/WorkflowActorModelUnboundError） | ✅（已 1:1） | FC 同源已有（create-workflow.ts:163-172）；**3.15 新增的绑定校验（bindScriptModels 族）补抄，并入 U2-5 任务清单** |
| N6 | 飞书群/话题协作 | host 直连 accounts.feishu.cn 注册（device-code 扫码）+open.feishu.cn API+WS 长连接收消息（无公网回调）；群开关 /enable、threadId 话题独立协作、话题历史增量归档、ReplyToChannel 权限层预批准（host/index.js@646900-734000） | ✅（不绑官方云） | 技术可 1:1；FC 第一代 provider 已自研分叉→以 FC 底座升级到上游群/话题形状；L 级，维持 P3 待决策 |
| N7 | 浏览器站点权限 | embedded session 装 4 handler+设备/蓝牙/displayMedia 监听；allowlist 4 项+可询问 13 项+**default-deny**；决策序=持久设置（origin×perm json）→本次 session-allow→prompt（20s 超时=deny）；四态卡+管理页三态下拉+重置（main@527158/742108） | ✅ | 四模块按上游结构 1:1 重建，13 项权限名与四态文案逐条抄（U1-4 止血+U2-4） |
| N8 | Linux 托盘驻留 | 托盘创建扩 linux（png 图标）；DBus StatusNotifierWatcher 三命令探测（gdbus/busctl/qdbus，1.5s 超时）；能力监视器 10s 缓存；关窗判定 (win\|linux)&&supported&&closeToTray；一次性迁移键+IPC+三态设置 UI（main@573518-577500） | ✅ | 全套照抄，图标/文案走改名面（U3-4） |
| N9 | 账户菜单套餐/复制 ID | 官方账号体系 UI（套餐接口+copy-user-id） | ❌ | 依赖 FC 已删除的官方账号链；且用户裁决 GLM 账号内容除外、FC 已主动移除升级入口 |

### 问题修复 12 项

| # | 条目 | 上游修复方式（证据锚点） | 判定 | 说明 |
| --- | --- | --- | --- | --- |
| F1 | 加速回合丢消息 | HighSpeed 专属编辑恢复路径（CLI 侧） | ❌ | FC 无 HighSpeed；公共路径（CommandInbox 队列）三轮验证低风险已知取舍 |
| F2 | 工作流状态显示错误 | 未行级定位：状态模型两版逐字一致（枚举/supersededBy/谓词 HP 同在）；可见增量=settings 血统解析+holes 状态 | ⚠️→可深挖 | 修复本体未定位，先五条回归断言收口（§10-G）；**再深挖路径**：对 vendored CLI 同源模块（workflow reducer / resume·amend 事件处理）逐函数解码 zcode.cjs 对应区，有希望升 ✅ |
| F3 | 更新失败不复查 | canPoll 扩 update-available+recheckAfterDownload+pending 补发+动态轮询 900s/120s（main@301647/319284） | ❌ | FC 更新链已整体删除，自有 updateChecker 已带失败退避；仅顺手清 2 个死 IPC（U1-5） |
| F4 | 权限默认放行 | =N7 的 default-deny 策略（从 Electron 隐式全放行→显式白名单+拒绝） | ✅ | U1-4 先止血（装 handler 即可），完整体系归 N7 |
| F5 | 本地文件打开失败 | OpenExternal 加 file: 分支→fileURLToPath→normalize+realpath→shell.openPath（main@709424） | ✅ | 1:1 + 恢复 FC 被 8ccf9b9c 误删的 OpenExternalFile handler（原文已从 git 找回，U1-1） |
| F6 | 群聊 @提及不准 | 消息 contentParts 映射 channelMention（targetId=ou_ open_id，host@686970） | ✅ | 随 N6 |
| F7 | 飞书授权过期无响应 | readBinding 校验 authorizationId 一致性→"Channel reply authorization changed" 结构化失败（host@633700） | ✅ | 随 N6 |
| F8 | 额度重置入口 | GLM 账号配额 UI | ❌ | GLM 账号独有，排除 |
| F9 | 滚动跳动 | ResizeObserver 加观察滚动容器高度；贴底态当帧：摘 observer→禁逐条补偿→收集全部行真实高度→flushSync 批量 resizeItem→单次 scrollToBottom→rAF 重挂（renderer styles@3426297） | ✅ | 同源 ConversationTimeline.tsx 逐块移植（U2-2） |
| F10 | 异常消息卡加载 | 修复落 CLI（zcode.cjs，两版 diff 未定位到坏消息处理增量）；可见相关=elide 索引削重（session/read contentProfile:"index"） | ⚠️→可深挖 | 可见部分 1:1：contentRejected+elide 四点；codecs 容错自研=唯一例外；**再深挖路径**：定点解码 zcode.cjs 的 session load/decode 链路（对照 FC CLI 同源模块），有希望找到上游容错实现、把例外也消掉 |
| F11 | Windows 链接启动安全 | 协议注册命令补尾部 `--`（win32 两分支，main@373022） | ✅ | 5 行照抄（U1-2） |
| F12 | 多工作区启动卡顿 | 启动预热目标 3→1（main 常量+host schema .max(1) 同步，main@354716） | ✅ | 2 行照抄（U1-3） |

### 判定汇总

**✅ 可 1:1 复刻 15 项**（N1-N8 含已完成的 N5、F4/F5/F6/F7/F9/F11/F12）；**⚠️ 部分 2 项**（F2/F10——修复本体在 minified 双版 diff 中不可见，但均留有再深挖路径：对 vendored CLI 同源模块逐函数解码，有机会升 ✅，深挖成本各约半天级）；**❌ 不复刻 4 项**（N9/F8 账号面、F1 HighSpeed、F3 更新链已删且自有等价物）。全部 ✅ 项按 §11 管线执行：明文资产逐字抄 / 同源反编译贴补丁 / 新模块 1:1 重建，验收=行为一致性（§7 并排对照法）。**R1 已裁决（2026-10-13）：保持现状保留 retune**，U2-5 按「并发-only 走 retune、其余照抄上游」执行。
