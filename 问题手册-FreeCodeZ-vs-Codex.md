# 问题手册：FreeCodeZ 对标 OpenAI Codex 桌面应用

- 日期：2026-10-01。基于对 `/Applications/ChatGPT.app`（= OpenAI Codex Desktop 26.928.21956 / CLI 0.159.2）的八轮只读调查（asar 解包、插件明文、二进制 strings、SQLite schema、DMG/签名/公证实测、协议面重建、i18n 全量枚举）。
- 配套文档：[差距分析（功能面全景）](./差距分析-FreeCodeZ-vs-OpenAI-Codex桌面应用-全面清查.md)、[提升点清单（行动方案）](./提升点清单-FreeCodeZ-基于Codex机制级拆解.md)。本手册是"问题视角"的最终收口：每条 = 一个问句 + Codex 的答案（附证据）+ FreeCodeZ 现状 + 差距定级 + 行动指针。
- 差距定级：★★★ 体验级差距（用户可直接感知）/ ★★ 工程级差距（影响能力上限）/ ★ 精细化差距（锦上添花）/ ✓ 已对齐或 FreeCodeZ 领先。
- 约束：FreeCodeZ 为纯本地应用，云侧机制（Aeon 云执行、连接器生态、Statsig、服务端语音模型、MDM）不入册。

---

## 〇、先说我们领先的（双向对照基线，2026-10-01 补轮修订）

以 FreeCodeZ 为基座重新盘点后（含技能生态逐篇质量对比与冲突面判定），以下为 **FreeCodeZ 明确领先或独有的面**，对照时不得只盯竞品：

| 能力 | 证据 | Codex 对应 |
|---|---|---|
| 四宿主形态（桌面/网页/headless server/IM bot） | packages/desktop、web、server、zcode-server-cli | 仅单桌面+手机配对 |
| Bot 异步双通道（TG/飞书/微信/webhook，长轮询+webhook） | packages/services/src/bots/ 22 文件 | 无 |
| 手机控"会话"而非整机，可纯 LAN 不出网 | webRemoteControl/ 18 文件 + embeddedRelay | 手机经 MFA 配对控整机（更大攻击面） |
| 多供应商 32 家模板（含 ollama/lm-studio 纯本地推理、MoMA） | config/provider/zcode-builtin.json | 仅 OpenAI+Bedrock |
| workflow 编排（编译器分层+delta 协议+并发控制） | dynamic-workflow/src 全套 | 无 |
| 本地调度三件件（cron 事务认领/offPeak 顺延/失败退避） | desktop/src/scheduler/index.ts | automations 依赖云触发+云调度 |
| 记忆本地闭环（11 文件：抽取/index/recall/agent-loop 复用只读判定） | core/src/memory/ | memories 云端流水线、本机空转 |
| **权限哲学**：5 协作模式 + 静态只读判定（20 文件 bash readonly policy）零摩擦放行 | core/src/permission/ | 三档审批+granular+Guardian 双模型（加摩擦换安全） |
| checkpoint→fork 双重回溯 + goal 随 fork 复制 + microcompact 显式标注式清理 | rewind/workspace-checkpoints/microcompact | thread/revert + 三阈值压缩 |
| **zcode-guide 诊断技能族**（5 诊断+配置地图，症状→原因→修复+定位工作流） | zcode-guide-plugin/skills/ | 无成建制对应 |
| 技能四件套质量（docx/xlsx 略优、pdf 明显优、pptx 相当）+ visual-judge 视觉裁决门 + CJK/公文深度 | ~/.zcode 官方插件 documents/pdf/presentations/spreadsheets | 见 Q33 修订 |
| 工具输出截断必落盘可续读（persistOutput on_truncate） | core tool bash.ts | output_token_limit 截断无落盘续读 |
| UX 已有强项：队列 20 键（sendNow/拖拽排序/暂停三因+resume）、错误 remedy 动作矩阵、上下文三源聚合面板、@提及六类 provider、设置 20 分区、反馈工单中心、ModelTrajectory 轨迹审计 | packages/ui/src 各处 | 部分对等或无 |

**冲突面（不该学）**：Sparkle 静默更新（与"产物不上传"决定冲突）、虚拟宠物/Orbit（DESIGN.md 气质对立）、WebMCP（Chromium 补丁=永久跟随负担）、Guardian 双模型审查（摩擦+成本）、企业 workspace policy（无企业面）、云端下发模型目录含系统提示（纯本地冲突）、Aeon 云执行（无云）。**适配可学**：MCP 延迟池、hooks mcp_tool、queue revision、goal 预算（已有 goal 面加字段）、压缩阈值参数化（已有三常量）。

---

## 一、分发与安全

**Q1 为什么 Codex 升级只要 2MB，我们的用户要重新下载整个安装包？**
Sparkle 2.9.1 增量更新：appcast 实测 12404→12553 delta 仅 2.26MB（全量 682MB），delta 回溯 5 个历史版本、每个独立 EdDSA 签名，日更节奏。FreeCodeZ 的更新链已随 fork 删除，无 publish feed，10 个平台产物只能手动重下。★★★ → 行动 P0-4/P0-5。

**Q2 为什么人家双击就能装，我们的包要教用户右键打开？**
Developer ID 签名 + 公证 + stapler 装订（离线过 Gatekeeper）；密钥放 Azure Key Vault（profile 名 "Codex Desktop AKV"，有效期到 2044）。FreeCodeZ 打包产物默认未签名。★★★ → P0-5 完整档。

**Q3 改了 asar 会被发现吗？**
会。Electron fuses 全量加固：asar 完整性校验（哈希烙进二进制）、OnlyLoadAppFromAsar、RunAsNode/NODE_OPTIONS/--inspect 全关、Cookie 加密开。FreeCodeZ 打包未配 fuses。★★ → P0-5。

**Q4 主进程被恶意插件偷跑网络怎么办？**
"Owl" Node 权限模型沙箱：启动时剔除全部权限参数与 NODE_OPTIONS，注入 `--codex-node-network-restricted --allow-fs-*=* --allow-ipc=<home>` 后自 relaunch，重启断言 `process.permission.has('net')===false` 否则拒绝启动；出网走 URL 白名单门禁。FreeCodeZ 桌面主进程无限网。★★ → P0-6。

**Q5 怎么在 Chromium 里做出"只有自己有的能力"？**
引擎级定制三明治：Electron 壳 + Chromium 打补丁（blink 层 `document.modelContext` WebMCP、`owl-*` 开关族：scoped UA/自定义 scheme/原生玻璃窗）+ 保留 chrome 层成熟件（PWA 快捷方式、install.sh）。内部代号 Owl（引擎）/Aperitif（seatbelt 沙箱垫片 dylib）/sky（CUA）。改名分层策略：只改用户可见层（显示名/keychain 标签"ChatGPT Safe Storage"/dock 图标），保留内部符号，fork 维护成本低。✓（工程参照，FreeCodeZ 无需改 Chromium，但"开关前缀化承接产品差异"的做法可学）

**Q6 跨平台打包做到什么程度才算认真？**
主进程 372 处平台分支：Windows 四构建风味（Nightly/InternalAlpha 走自研 MSIX 更新器、Beta/Prod 走商店 ID + windows-store-update.json manifest）、HKCU 默认浏览器探测、AppContainer 编译沙箱（tectonic.exe 专用）、PowerShell 通知音、WSL 双向路径桥（wsl.exe -lc + WSLENV + 路径翻译）；Linux 按 XDG_DATA_DIRS+flatpak exports 自动发现 .desktop 应用与终端、/etc/alpine-release musl 检测、按平台键（linux-aarch64 等）首启下载运行时。FreeCodeZ 有 10 产物矩阵但"只做到能装能跑"，且当前决定不上传发布。★★ → 跨平台三条建议（更新 feed 恢复 / musl 变体或按需下载 / XDG 与默认浏览器发现）。

## 二、协议与架构

**Q7 协议面谁更完整？**
codex app-server 约 100 方法 + 70 通知事件，域覆盖 thread（40+：archive/revert/inject/queue/attachment/section/search/timeline）、turn、fs 文件桥（12）、command/exec+PTY（11）、account（15）、remoteControl（7）、plugin/skills/marketplace（17）、goal、realtime 语音（5+12）。FreeCodeZ 75 方法，其中 workflows/automation/offPeak/provider 域为 codex 所无（领先），但 thread 生命周期细化、fs 桥、PTY 控制、审批回执、用量限额面缺失。★★ → 补 5 项（见 Q8-Q10）。

**Q8 会话内容怎么传给 UI？**
**Q8 会话内容怎么传给 UI？（2026-10-03 二次修正：FC 已有 token 级流式）**
~~此前误判"FC 是拉模式快照、无流式"~~。代码实证：协议有 `model.streaming` 事件（payload 含 `delta` 字符串增量 + `done` + `partId` + `assistantMessageId` + kind 枚举），services 层有专门的**事件合并器**（zcodeSessionEventCoalescer）消费，渲染层 conversationProjectionStore/ConversationRowView 处理 delta——**打字机级流式管线已存在**。与 Codex 的残余差异收敛为覆盖面细节（工具输出 delta、reasoning delta 的粒度对比未逐项核）与大对象分块传输（chunked 协议，P1-6 仍立）。✓/★（从 ★★★ 降级）

**Q9 agent 在沙箱里跑，文件读写谁做？**
宿主文件桥：`fs/readFile|writeFile|watch|walk|copy…` 12 方法 + `fs/changed` 通知，桌面代 CLI 读写与监听。FreeCodeZ 无文件代理面。★★ → 新增（成本低，Node fs 天然支持）。

**Q10 审批是事件还是请求？**
请求-响应闭环：server→client 发 `execCommandApproval`/`applyPatchApproval`/`item/tool/requestUserInput`（带请求 ID），宿主应答后收 `serverRequest/resolved` 回执。写盘类审批（applyPatch）独立分类。~~FreeCodeZ 的 permission.requested 是单向事件~~（**2026-10-03 修正：错**——FC 的 `permission.requested`/`permission.resolved` 事件对**均带 requestId 关联**，且 payload 含 `riskLevel` 四档分级（low/medium/high/critical），另有 `interaction/requestPermission` 请求-响应方法——回执闭环与风险分级已存在，与 Codex 仅剩架构风格差异（事件对 vs 反向请求）。✓

**Q11 宿主和 CLI 版本不匹配怎么办？**
initialize 响应的 userAgent 携带 semver，宿主按版本门控特性（supportsPaginatedThreadHistory/threadAttachments 等），低于 0.149.0-alpha.4 拒绝连接；CLI 侧 `--strict-config` 未知配置键即报错。FreeCodeZ 的 runtime/capabilities 是能力快照，缺版本协商与降级。★

**Q12 会话持久化用什么格式？**
事件溯源 JSONL（rollout）：每行 {timestamp, ordinal, type, payload}，六类型——session_meta（含完整 base_instructions 与环境快照）/ turn_context（每轮沙箱+审批策略快照）/ event_msg / response_item（message/reasoning/工具调用）/ **world_state**（世界状态整存）/ token_usage_record（turn/thread 双层计量）。索引与正文分离（session_index.jsonl 三字段，可从 rollout 重建）。另有迁移机制（rollout_migration_state + paginated thread history）。FreeCodeZ 用 SQLite sessions/messages/todos——查询强但"完整可重放的历史事实"弱。★ → 评估给 SQLite 加 event-log 表或在 session 里存 turn_context 级快照。

## 三、MCP 与工具治理

**Q13 接入一个 50 工具的 MCP server，system prompt 会爆炸吗？**
不会。三层裁剪：enabled_tools 白名单 / omit_tools_from: {code_mode, deferred, direct}（deferred = 不进 system prompt，进延迟池，模型用内置 tool_search 按需检索；feature flags tool_search / tool_search_always_defer_mcp_tools / deferred_tool_world_state）+ 宿主侧动态过滤。FreeCodeZ WIP 已有 disabledTools + token 估算 + schemaLarge 标注，缺"第三态：可见但不注入"。★★★ → P0-1。

**Q14 一条工具输出 5 万 token 怎么办？**
按工具 output_token_limit（如 js REPL 25000），CLI 在 tools/call 路径执行期截断。FreeCodeZ 只估注入成本不管输出。★★ → P0-2。

**Q15 MCP server 能拿到宿主的全部环境变量吗？**
不能。`.mcp.json` 的 env_vars 声明式白名单（code-review 只透传 22 个：GH_TOKEN/代理/CA），宿主只注入列表内变量。FreeCodeZ 子进程疑似全量继承。★★ → P1-3。

**Q16 插件配置怎么做到四层合并不打架？**
静态 .mcp.json 底座 + 每回合扁平点号键覆盖（`plugins.<id>@<marketplace>.mcp_servers.<server>.<field>`）+ 用户 config.toml + 企业策略，正交合并不重写文件；物化缓存（~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/）+ 原子替换 + integrity.json sha256 清单。FreeCodeZ 有 updateMcpServer 写路径，无 per-turn 覆盖与物化缓存。★

**Q17 hooks 能不 spawn shell 吗？**
能。handler 双类型 command / mcp_tool（hooks 直接调 MCP 工具，input 用 ${session_id}/${agent_id}/${turn_id} 模板变量）；12 事件（含 PreCompact/PostCompact/SubagentStop）；PreToolUse 可返回 permissionDecision allow/deny/ask 短路审批，PostToolUse 可 decision:block + additionalContext；输出 schema 严格白名单、保留字段出现即 fail-closed；信任态 trusted_hash + "Continue without trusting (hooks won't run)"。FreeCodeZ 信任链更细（SHA256 双摘要+6 reasonCode）但缺 mcp_tool 类型与决策语义。★★ → P1-1。

**Q18 危险工具和它的使用规范怎么强制绑定？**
documents.json 门控：`requiredFor: [tab_cdp_call, webmcp_invoke_tool, …]` —— 会话一旦启用高危工具，对应政策文档必须注入；`when` 按后端类型/API 成员/能力存在性裁剪。安全从"希望模型记得"变成"清单机械保证"。★★★ → 接 MCP WIP 与 browserView（政策文档 + requiredFor 清单）。

## 四、上下文与状态管理

**Q19 长会话怎么续命？**
自动压缩三键（model_auto_compact_token_limit + scope、post_turn_compact_threshold_percent、compaction_image_budget）+ PreCompact/PostCompact hooks + "压缩中"状态可视（i18n: contextAutomaticallyCompacted）+ compact.rs "超限则删最旧历史项再压" 兜底。FreeCodeZ 有三层压缩+microcompact，已对齐压缩本体；缺压缩事件 hooks 与阈值百分位配置。✓/★

**Q20 过夜任务/被打断的目标怎么恢复？**
goal 行（token_budget/tokens_used/time_used + status: active/paused/blocked/usage_limited/budget_limited/complete）+ continuation_deferrals 空表原子"待续位" + turn_suspension（挂起而非终止）+ `codex queue` 子命令排队消息。本机实测 goals/queue 表全空转——预建能力。FreeCodeZ 有 session/goal 协议，缺预算字段与待续位。★★ → P2-1。

**Q21 每条命令都要 source 一遍 .zshrc 吗？**
不用。每 thread 一次 shell 快照：真实登录 shell 里分节 dump（functions/setopts/aliases/exports，NUL 分段、env -0、command -p 防劫持、broker 凭据扫描拒绝、大小上限），后续命令 `. /dev/fd/N` 直接恢复；快照随会话清理（本机复查已删）。FreeCodeZ 已有三处快照实现（bash-shell-snapshot 等）。✓/★ → P3-3 加固三点。

**Q22 agent 的输入在它忙的时候去哪了？（2026-10-03 修正：此项我们已对齐且更严谨）**
~~此前误判"CommandInbox 是内存态、重启丢消息"~~。代码实证：`session-inputs.ts` 是 SQLite 账本——admitted→promoted/cancelled/discarded/failed 状态机，`admitted_sequence` 编号，**promotion 与 user message 同事务落 transcript**（注释明言已消灭"queue 消费但 transcript 无消息"的孤儿窗口）。Codex 的 queued_items+revision 触发器方案我们已有等价物且原子性更强。残余差距仅剩 goal 侧：**预算字段（token/时间）+ 重启后"待续跑"标记位**（Codex continuation_deferrals），属 P2 增强。✓ → 仅余 P2-1。

**Q23 日志怎么做到既能查又不泄密？**
单表 logs（ts/thread_id/level/target=Rust 模块路径/feedback_log_body/estimated_bytes），四索引（时间倒序/按线程/组合/后台进程部分索引）；应用层 {safe, sensitive} 双桶标签，Sentry/OTel 分流。FreeCodeZ 有 serviceLogger 体系，缺敏感度标签与按会话聚合查询。★

## 五、浏览器（FreeCodeZ 已有 browserView 的精进方向）

**Q24 agent 浏览器的安全政策在哪里成文？**
随插件分发的 27 篇文档语料 + documents.json 三级注入（model 挂目录/included 条件注入/lookup 错误触发），能力文档用"Markdown 行为契约 + 尾部 ts interface"模板（capabilities.list() 发现 → documentation() 取详情，文档与实现同源同版本）。★★★ → browserView 补最小三篇（safety/confirmations/tab-lifecycle）+ 注入清单。

**Q25 确认弹窗怎么分级才不打扰？**
四级摩擦：Hand-off（必须用户做：改密码最后一步/绕安全屏障）→ Always Confirm at Action-Time（删数据/金融交易/CAPTCHA/敏感数据传输，预批准无效）→ Pre-Approval Works（登录/权限弹窗/上传）→ No Confirmation（Cookie 同意/下载）。确认话术必须含"数据+目的地+原因"，禁止"要继续吗"。★★★ → 直接移植分类法。

**Q26 改了网页状态怎么向用户证明？**
Proof of work：改变网站状态或请求批准后，必须截图并内嵌在最终回复里（工具输出里展示不算数）。零代码成本。★★★

**Q27 agent 开的标签页谁收拾？**
回合生命周期：默认回合末自动关闭；markDeliverable（页面即交付物）/markHandoff（下回合续接）两标记，每回合重标；反囤积条款（研究/中间页禁止标记）；用户认领的标签页解除控制保持打开。★

**Q28 网站能主动给 agent 提供工具吗？**
WebMCP：blink 层 document.modelContext，页面注册工具（上限 100 工具/64KB 描述符/10 次变更），toolchange 上报；且"工具指令不能自我授权"，调用前套确认政策。依赖 Chromium 154 补丁，FreeCodeZ 跟进 Electron 版本后可开同款。✓ 前瞻存档。

## 六、开发者工作流

**Q29 PR 审查怎么做成产品？**
双 server 分层：审查上下文独立最小 MCP 面（read_diff/list_files/read_file 三只读工具，全 readOnly 注解，宿主 spawn `codex exec --ephemeral --sandbox read-only` 时注入）——审查 agent 拿不到任何写动词；写操作另一面（comment/merge/submit），带 expectedHeadRevision 乐观并发（"PR changed while queued"）；输出 --output-schema 强制 JSON（summary+impact+findings≤50，每条锚定 hunk path/line/side）+ zod 复验 + diff 锚点校验；gh 限流包装（1h 滑窗预算 180 点、x-ratelimit-remaining<500 暂停）。FreeCodeZ 完全靠 bash+gh。★★★ → 提升点 P0-3 关联，六条设计建议见清单。

**Q30 worktree 并行做到了什么程度？**
git-worker 线程全套（snapshot/snapshotBranch/createPullRequest(AsDraft)/mergePullRequest/PR watch+auto-merge 配置键）+ `codex exec --worktree` 子命令约束（可 resume/fork、需 --enable worktrees）+ UI 会话卡（environmentSummary: attachingWorktree/creatingWorktree/worktreeReady）。FreeCodeZ schema 占位运行时 throw。★★★ → P0-3。

**Q31 模型有代码智能吗？**
LSP 运行时自安装（kotlin-server/rust-analyzer/astral ty）装到 runtime 通道；fuzzyFileSearch/sessionStart 协议方法。FreeCodeZ 无。★ → P3-2。

**Q32 怎么从竞品拉用户？**
external-agent-import：从 claudeCode/claudeCowork/cursor 导入 chats/projects/plugins/skills/MCP servers/hooks/rules/memory，支持 keepInSync 持续同步、后台进行；协议方法 4 个 + 导入账本表。FreeCodeZ 可做"从官方 ZCode 迁移"同类导入器。★

## 七、技能体系

**Q33 官方怎么写 SKILL.md？（2026-10-01 修订：单向印象已纠正）**
Codex 范式 = 三段式 description + references/scripts 分层 + 硬契约句。但**逐篇质量对比后"写得更好"总体不成立**：FreeCodeZ 文档四件套（docx 的 postcheck 14 规则+visual-judge 视觉裁决+7 封面配方、xlsx 的 LibreOffice recalc 重算+三角色流水线、pdf 的四工作流+12k 行脚本、pptx 的 Budget 公式+OOXML schema 坑位）与 Codex 同级或更优；CJK/公文/WPS 深度是 Codex 完全没有的。Codex 真正占优的只有两点：**computer-use 的四级确认政策成文**（我们只有散在约束）、**presentations 的程序化几何校验附件**（99KB，我们是启发式预算）。"更多"在默认策展口径下成立（curated 39 vs 我们 CDN 16 且偏科金融），但 FreeCodeZ 个人源机制可直接挂 Claude 官方 286 插件目录。✓/★ → 行动：补 computer-use 确认政策成文 + 市场品类均衡；写作范式不必妄自菲薄。

**Q34 多个相似技能怎么让模型一次选对？**
互斥路由表：openai-docs 的 "Choose one primary route"——每条 bullet = 条件→读哪个 reference→何时不读，强制"最多读一个"。FreeCodeZ 的 architecture-governance/feature-boundary-planner/dep-refs/dogfood 存在路由重叠。★★

**Q35 交付物质量怎么兜底？**
双产物交付契约（deep-research report-contract）：内部 sidecar（保留机器引用供评测追溯）+ 用户交付物（转人类脚注、不泄漏内部 ID）+ QA 门槛（逐页 100% 缩放检查，六类缺陷清单）+ 失败契约（"没逐页看过就永远不许说 visually verified"；失败报阻塞不静默降级）。★★

**Q36 技能怎么被模型调用？**
三通道：隐式 description 路由（可被 allow_implicit_invocation 显式关闭，官方原则："不要因为敏感就 explicit-only，保持可发现，授权放在变更前"）/ $skill 显式提及（ProseMirror mention 节点，模型输出经 custom_symbol_offsets 重建 $ 标记，双向）/ UI default_prompt 按钮（落地仍是 $ 提及）。`.skill` 文件类型双击安装（HandlerRank Owner）。FreeCodeZ 有指针描述与门控，缺 $ 提及与文件类型。★ → P2-3/P2-4。

## 八、交互设计（UX）

**Q37 agent 忙的时候用户能说话吗？（2026-10-01 修订：此项我们反超）**
Codex：消息排队 17 键 + steer。**实测 FreeCodeZ 队列面更宽**：`chat.queue.*` 20 键——sendNow 立即、编辑撤回到 composer、删除、**拖拽排序**、暂停横幅（stopped/error/generic 三因）+ resume 中断恢复、发送确认（清空/保留）；steer 语义也有（guide/queue 双模式，⌘/Ctrl+Enter 反转投递即抢占）。剩余真差距只有一个：**普通关窗/退出 App 时枚举活跃任务确认**（目前仅 logout 与更新重启有，见 ConversationFileRewindDialog 同款模式可复用）。✓/★

**Q38 历史流怎么做到安静又可审计？**
折叠 turn 披露行："Worked for {time}" + "{count} previous messages" + **"{count} denied actions"**（被拒操作计数）；工具活动 = 工具×状态 i18n 矩阵 + repeatedToolCalls 折叠 + 汇总句式引擎（9 类 summary.leading 拼装）。★★★

**Q39 自动放行的危险操作事后怎么管？**
自动审批事后审查卡：先放行、turn 末集中审查，六种结局（approved/denied/deniedHighRisk/aborted/timedOut）+ 事后 approve + /autoReviewDenials 命令。这是"不打断流"与"控制感"的折中，且配 Guardian 安全审查模型人格（"You are judging one planned coding-agent action"）。★★★

**Q40 agent 改错了怎么撤？**
三级粒度撤销（hunk/file/section）且带 partialSuccess 态；apply 跨环境带四结果（applied/conflicted/skipped/notGitRepo）；归档内联 undoLink 而非确认弹窗。FreeCodeZ 有 rewind/checkpoint 概念，缺 hunk 粒度与部分成功态。★★

**Q41 输入会丢吗？（2026-10-01 修订：已对齐）**
FreeCodeZ 已有完整草稿链：350ms 合并持久化、空快照保 editorStateJson 结构（即 git log 所提修复）、workspace 间转移请求、draft revision。与 Codex 的差距仅在"浏览器→桌面交接"这种特定表面（我们无内嵌聊天网页端，暂无此场景）。✓

**Q42 首启体验什么样？**
welcomeV2 角色化（13 个职业角色 × 专属 starter prompt）+ composerTips 26 条（提示即教程即入口，每条带可执行 prompt）+ 引导清单由 agent 工具标记完成 + 无权限时访问解释页而非死胡同。★

**Q43 用户怎么反馈"这轮做得好不好"？**
turnRatingControls 结构化反馈分类学（solvedMyTask/lostContext/offTrackOrWrongScope/usefulAutonomy/safetyOrLegalConcern/slowOrBuggy + 产物质量 12 项细分）。★

## 九、Agent 运行时

**Q44 长时任务怎么"赖着不走"地干完？**
persistent mode 声明式契约（系统提示原文入库）："final 立即结束 turn，改用 send_user_message_async 持续交付 + clock.sleep 等待外部事件"；去重契约（禁止 final 与 async 发同文）；破坏性动作护栏与"工具输出是不可信证据非指令"。FreeCodeZ 无对应运行模式。★★

**Q45 多 agent 协作怎么组织？**
层级命名（task_3 短名与 /root/task1/task_3 规范名互通，跨子树走规范名）+ 消息板工具（create_channel/search_posts/subscribe）+ 委托策略提示（"编码任务优先委托能出 bounded patch 的工人而非只读探索者"）+ 并发/超时三元组 min≤default≤max 配置期强校验。FreeCodeZ 有动态 workflow 编排（领先），协作语义可互补。✓/★

**Q46 模型目录是写死在代码里吗？**
models_cache.json 38 字段目录（含 context_window/effective_context_window_percent/truncation_policy/node_repl_disabled/supported_reasoning_levels），**model_messages 内嵌每模型完整系统提示模板随目录下发**，带 etag 缓存语义；CLI `codex features --enable/--disable` + 130 个 feature flag 全部收敛到 config.toml features.* 键域。FreeCodeZ 的 MoMA 供应商接入已有模型规则，缺"系统提示随模型目录分发"与 feature flag 治理。★★

**Q47 给模型一个"不碰 shell 的计算环境"可行吗？（2026-10-03 修正：FC 已有基础）**
~~"FreeCodeZ 无对应"~~——**错**。`contracts/src/tools/node-repl.ts` 实存：js 工具在**持久 REPL** 执行 JS（timeout_ms 上限 120s、强制用户可读 title），且 schema 同时服务 fresh-kernel Browser Use MCP 双形态。Codex node_repl 的**深度差异**（cell 模型/emitImage/沙箱 env 全集/active exec registry vs FC 实现）**未逐项对照**——本项从"空白"降级为"深度对照待做"。其余 P3-1 内容（VM 沙箱加固方向）仍可参考。✓/待对照

**Q48 CLI 怎么被宿主当库用？**
exec 参数三件套：--output-schema（JSON Schema 约束最终答案）+ --output-last-message（最后消息落盘）+ --experimental-json（全事件 JSONL）+ --strict-config + --ephemeral/--worktree/--review-context。另有 exec resume/fork/review、queue、apply（把 agent diff git apply 到工作树）、sandbox、doctor、cloud、desktop 子命令全集。FreeCodeZ CLI 有 --daemon serve（领先），缺结构化输出契约。★★

## 十、平台工程杂项

**Q49 重工具链（LaTeX/Office/LSP）怎么随包？**
运行时下载通道：装到 ~/.cache/codex-runtimes/<runtime>/（runtime.json 逐文件 sha256 + sources.json 构建溯源 + bundledPlugins/bundledSkills/skillsToRemove 迁移字段）；tectonic 0.17（51MB）与 rg 15.2 随包但 Windows 下 tectonic 跑在 AppContainer 编译沙箱里。FreeCodeZ 的 pdf/pptx 技能依赖用户自装工具。★★ → P2-5。

**Q50 模板/主题这类"轻资产"怎么管理？**
artifact-template-picker 独立 MCP server（list/choose_artifact_templates，模板≤100、预览 8MB/16MP 限额）；dock 图标主题感知三态（codex-light/dark/system）+ 通知角标；通知音两套主题 + 用户自定义（≤10MB）。★

## 十一、补盲轮新发现（2026-10-01）

**Q51 文档生成为什么 Codex 的产物一致性感更强？**
primary-runtime 是 1.5GB 自包含工具链（LibreOffice 414M + poppler 182M + Node 443M + Python 361M 全钉版本），自研 `@oai/artifact-tool`（xlsx/pptx 统一 JS 内核，真实公式重算、inspect/render 自省、JSX 写 deck），"渲染即验收"硬门 + 机器验证器军团（99KB 几何校验/包完整性/图表算术门/模板保真门），模板闭环（picker MCP→蒸馏→template-creator 沉淀为个人技能→回调）。FreeCodeZ 四件套的验收门与写作质量不输（visual-judge+postcheck），差距在**工具链自包含**（依赖宿主 LibreOffice/python，行为可复现性差一档）与**模板资产管道**（我们是封面配方，无用户模板沉淀闭环）。★★ → 提升点 P2-5 运行时通道 + 模板沉淀可立新项。

**Q52 还有哪些隐藏产品线？**
zh-CN 全量 28187 键枚举出四条：①门控实验面（Aeon 消息化智能体：Email/Slack/Teams 通道+USB Passkey；Orbit 远程电脑语音通话）；②"Codex 安全"扫描工作台（SAST 型：attack path/CWE/置信度/多路独立审查汇总/修复 patch，可跑远程主机）——**这条本地可实现，值得评估**；③工作区智能体构建器（可视化构建/9 色头像/挂 skills/发布目录/记忆面板/定时调度/权限可聊可编辑）——与 FreeCodeZ 的 subagents+automation 组合可拼出等价物；④appgen 网站生成器（带数据库/自定义域名/DNS 引导）——云端托管，不入册。另 personalVault 凭据保险库（63 键）、browserAuth 身份重放确认（63 键）两个小而值得抄的面。★

**Q53 技能货架怎么做出"更多选择"的观感？**
三层货架：即时物化 13 + 系统技能 5 + curated 推荐 39（openai/skills 仓库 partial clone，定期刷新 skills-curated-cache.json，UI"推荐"区一键安装）。FreeCodeZ 的等价物：官方快照 16（偏科金融 10 个）+ 内置 15 + 个人源。差距不在机制（我们个人源更强）在**策展**：没有 curated 推荐流。★ → 低成本补一个"推荐技能"目录源即可改变观感。

## 十二、设置页视角（用户截图触发的补查，2026-10-01）

**Q54 设置页体系差距在哪？（截图实证 + 4658 键逐页枚举）**
Codex 设置侧栏四组（个人/集成/编码/已归档）约 30 页，与 FreeCodeZ 20 分区对照后真正独有且值得补的：**应用快照页、Worktrees+Git 成页、代码审查页、钩子信任治理**；FC 反超的：常规（含 Provider）、插件（有商店）、导入（双向迁移）。浏览器页差距最大（310 键 vs FC 单页：清除数据五类六时段/站点设置 18 项/扩展管理器/Chrome 配置导入/CDP 开关）。细节彩蛋：Codex 自己的 zh-CN 也有漏翻（confirmBeforeClose 整组 7 键未翻译，截图里"Confirm before closing a window"即证据）。★★ → 见 Q55/Q56 与建议。

**Q55 权限双开关其实不是开关——"可用性+风险披露+确认"三段式 UX**
实测映射："默认权限"是永远勾选的**只读信息行**；"完整访问权限"是真实开关但只控制 **composer 权限菜单里 full-access 模式是否可见**（permissions-mode-visibility chunk 1060 字节，全逻辑）；开启时确认弹窗明示"只是加入菜单，不会自动选中"；帮助链接 help.openai.com/articles/20001530。三层状态机：托管策略∩设置可见性→菜单集合；会话选模式→profile（read-only/:workspace/:danger-full-access→对应 sandbox+approval 组合）；granular flags→运行时逐项。两个机制级细节值得抄：(a) 危险模式**永不允许成为持久化默认**（schema exclude）；(b) danger 档"粘性"+会话级可关闭的警告横幅。★★ → 对 FC 的 yolo 模式直接套用三段式（默认隐藏+确认弹窗列明文件/终端/网络三项能力+会话横幅）。

**Q56 应用快照（Appshot）：被低估的低成本高感知功能**
全链路：全局"同键双击"热键（两个⌘/两个⌥/两个⇧，无需组合键）→ 最前台窗口**图像 + AX 树文本（含滚动到屏幕外的内容）** → 三档路由（自动/当前聊天/新聊天）→ 以 `<appshot window-title image>` 结构块注入 prompt（图给视觉、AX 给文本）。FC 已有全部原语（CUA 截屏 readiness probe、CGPreflightScreenCaptureAccess、会话路由），缺的只是产品面装配：热键服务+附件双视图（截图/纯文本切换）+firstUse 弹窗。AX 树注入解决了纯截图丢文本的问题，值得原样吸收。★★★ → 新提升点（成本最低收益最高档）。

**Q57 导入页：竞品迁移的完整契约**
来源三家（Claude Code/Claude Cowork/Cursor）、十类内容（agents/chats/commands→技能/hooks/说明/MCP/记忆/插件/设置/技能）、**格式转换规则成文**（settings.json→config.toml、CLAUDE.md→AGENTS.md、Cursor rules→AGENTS.md）、keepInSync 持续同步（detect→import→autosync 三 IPC）、导入历史含 needsReview/authRequired 态。FC 的 migration 区已有（ExternalAgentImportDialog+MigrationCandidatesCard，Claude 会话+ZCode 导入），缺：Cursor 来源、chats/instructions/memory/hooks/settings 五类、转换规则披露、持续同步。★

---

## 附：按差距定级的速查表（2026-10-01 修订版）

| 定级 | 条目 |
|---|---|
| ★★★（13） | Q1 更新增量、Q2 签名公证、Q8 流式事件、Q13 工具延迟池、Q18 工具-政策绑定、Q24 政策成文、Q25 确认四级、Q26 proof-of-work、Q29 PR 审查、Q30 worktree、Q33 技能范式、Q37 非阻塞输入、Q38 折叠披露、Q39 事后审查、Q47 JS 内核 |
| ★★（16） | Q3 fuses、Q4 网络沙箱、Q6 跨平台深度、Q7 协议面、Q9 文件桥、Q14 输出限额、Q15 env 白名单、Q17 hooks mcp_tool、Q20 goal 续跑、Q22 队列持久化、Q34 路由表、Q35 交付契约、Q40 分级撤销、Q44 persistent mode、Q46 模型目录、Q48 CLI 库化、Q49 运行时通道 |
| ★（12） | Q10 审批回执、Q11 版本协商、Q12 事件溯源、Q16 四层配置合并、Q19 压缩 hooks、Q23 日志双桶、Q27 标签生命周期、Q31 LSP、Q32 竞品导入、Q36 $ 提及、Q41 草稿恢复、Q42 首启、Q43 反馈分类、Q50 轻资产管理 |
| ✓ | Q5 引擎定制（参照）、Q19 压缩本体、Q21 快照本体、Q28 WebMCP（前瞻）、Q45 多 agent（互补领先） |

**一句话总结（修订版）**：FreeCodeZ 的基座比此前历轮报告呈现的强得多——权限哲学、队列/草稿/回溯 UX、文档四件套质量、诊断技能族、四宿主与 Bot 通道都是领先或独有面，真正的体验级差距收敛为：**分发链（Q1-Q3）、流式协议与文件桥（Q8/Q9）、diff 审查粒度（Q40）、命令面板量级、工具-政策强制绑定（Q18）**五处；工程级差距里最值得拿的是 MCP 延迟池、hooks mcp_tool、queue revision、goal 预算、运行时自包含工具链（Q51）。凡改变"本地、无摩擦、不丢上下文"底色的机制（Guardian、四级确认、云下发、Chromium 补丁）已在冲突面判定中明确拒绝。
