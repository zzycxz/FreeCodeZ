# 终版双向对比报告：以 FreeCodeZ 为基座

- 日期：2026-10-01。本报告是对 ChatGPT.app（OpenAI Codex Desktop 26.928.21956）调查的收口之作，修正此前"单向仰视"视角。
- 方法：Codex 侧累计 15 个子任务（asar/插件/二进制/SQLite/DMG/协议/i18n 28187 键全枚举/primary-runtime 文档套件/技能语料逐篇）；FreeCodeZ 侧 3 个专项（技能生态逐篇质量、12 项领先面+20 条冲突面判定、渲染层 UX 12 项盘点）。
- 配套：[问题手册](./问题手册-FreeCodeZ-vs-Codex.md)（50+3 问，已修订）、[提升点清单](./提升点清单-FreeCodeZ-基于Codex机制级拆解.md)、[差距分析](./差距分析-FreeCodeZ-vs-OpenAI-Codex桌面应用-全面清查.md)。

---

## 一、FreeCodeZ 基座画像（先立住自己是谁）

**纯本地、四宿主（桌面/网页/headless server/IM bot）、多供应商（32 家模板含 ollama/lm-studio 纯本地推理）的 AI 工作台**，同一 agent core 服务编程与办公双模式用户。四条设计原则（安全不添麻烦/不丢上下文/不做熔断/无常驻 shell）不是口号，而是已兑现的架构事实：

- 安全靠**静态语义判定**而非审批摩擦：5 协作模式 + toolDisallowlist + 20 文件 bash readonly policy（argv/flags/git 子命令级只读判定→自动放行）。竞品用三档审批+granular 五粒度+Guardian 双模型审查达成近似目标，但每一步都在加确认摩擦。
- 不丢上下文是**实现级承诺**：工具输出截断必落盘可续读（`persistOutput: on_truncate`）、checkpoint→fork 双重回溯（goal 状态随 fork 复制）、microcompact 显式标注式清理（`[Old tool result content cleared]` 而非静默摘要）。
- 无常驻 shell：bash 按调用起停，常驻的只有受管 scheduler/supervisor。

## 二、双向能力矩阵

判定：**FC 领先 / 对等 / Codex 领先 / 各有路线**。

| 域 | 判定 | 要点 |
|---|---|---|
| 宿主形态 | **FC 领先** | 四宿主+Bot 双通道（22 文件，TG/飞书/微信/webhook，长轮询+webhook 双 runtime）vs 单桌面+手机配对 |
| 模型接入 | **FC 领先** | 32 供应商三协议+本地推理+MoMA 发现 vs OpenAI+Bedrock |
| 手机远控 | **各有路线** | FC：控会话、LAN 优先不出网；Codex：控整机、MFA 强制、经云 |
| 权限/安全 | **各有路线（FC 哲学更合原则）** | FC：静态只读判定零摩擦 + 灾难形态地板（yolo 四类封闭清单）+ 无人值守审批超时 120s + **三平台自研沙箱**（E 批：seatbelt/bwrap/Windows MIC）vs Codex 审批分级+Guardian；FC 该学的只剩"政策成文化"表达层（浏览器四级确认/工具-文档强制绑定） |
| 会话回溯/压缩 | **对等偏 FC** | rewind+checkpoint→fork+microcompact vs revert+三阈值压缩 |
| workflow/自动化 | **FC 领先（本地性）** | workflow 编译器全套+SQLite 事务认领调度 vs 无 workflow、云触发云调度 |
| 记忆 | **FC 领先（本地闭环）** | 11 文件抽取/index/recall/agent-loop（复用只读判定）vs 云端流水线本机空转 |
| 协议面 | **各有侧重（2026-10-03 修正）** | FC 75 方法（workflows/automation/offPeak 独有）+ model.streaming token 级流式（delta/partId/kind+事件合并器）+ permission 事件对带 requestId 与四档风险分级——~~"拉模式快照/无流式/无回执"为误判~~；Codex 多出 fs 桥 12 方法、PTY 控制面、~100 方法总量与粒度更细的增量事件（工具输出/reasoning delta） |
| MCP 治理 | FC 接近合入 | FC WIP（工具级开关+token 估算+目录缓存）；Codex 多出延迟池 tool_search、output_token_limit、env_vars 白名单、per-turn 覆盖键 |
| 文档产物 | **FC 质量优、Codex 工具链自包含** | 见第三节 |
| 桌面控制（CUA） | **Codex 略优** | 四级确认政策成文+96MB 原生 AX 服务+活动流/录制；FC 的 CUA broker+错误码体系强在恢复语义、弱在政策成文 |
| 浏览器 | **对等偏 FC** | FC browserView 38 文件+双技能（协议细节更深：预动作 tab 验证协议）；Codex 多 27 篇政策文档+documents.json 强制绑定+WebMCP |
| 开发者工作流 | **Codex 领先** | worktree 落地+PR 审查产品化（双 server 分层+乐观并发）+LSP 自安装；FC worktree throw、PR 靠 bash+gh |
| 交互 UX | **FC 多数对等或反超** | 见第四节 |
| 分发链 | **Codex 领先（唯一体验级断层）** | 签名公证装订+fuses+Sparkle 增量（2.26MB/300 倍）vs 未签名+无更新通道 |
| 观测/运维 | **Codex 领先** | Sentry+OTel+Statsig+任务管理器+trace 上传 vs 无（本地应用可取轻量子集） |

## 三、技能/插件生态对比（逐篇质量，纠正"写得更好"的印象）

**FreeCodeZ 四件套 vs Codex primary-runtime 文档套件：**

| 能力 | Codex（primary-runtime） | FreeCodeZ（官方插件） | 判定 |
|---|---|---|---|
| docx | python-docx+OOXML patch+LibreOffice 渲染门+40 脚本 | docx-js+postcheck 14 规则+**visual-judge 视觉裁决子代理**+7 封面配方+7 场景 | **FC 略优**（验收门/模板/CJK） |
| xlsx | artifact-tool 重算引擎+inspect+Do-Don't 矩阵 | LibreOffice recalc 重算+xlsx.py 7 命令+三角色流水线+设计令牌+VBA+金融分级 | **FC 略优** |
| pptx | 几何校验 99KB 附件+slop 分类法 | Budget 公式+OOXML schema 坑位知识+slop 17 条（无脚本附件） | **相当**（写作 FC 略优/工程附件 Codex 略优） |
| pdf | poppler+AcroForm（处理型） | 四工作流（ReportLab/Playwright/Tectonic/pikepdf）+12k 行脚本+form.fill | **FC 优** |
| 浏览器 | 150 行加载器+27 篇 docs | control-browser（协议更深）+web-gui-tester（方法论）双技能 | **FC 略优** |
| 桌面控制 | 四级确认政策成文 | 306 行错误码/幂等重试强，无成文确认政策 | **Codex 略优** |
| 宿主自诊断 | 散篇 reference | **zcode-guide 5 诊断+配置地图**（症状→原因→修复+定位工作流） | **FC 明确优（独有）** |

**货架对比**：Codex 即时 18 + curated 推荐 39（openai/skills 仓库定期刷新）≈ 66 可触达；FreeCodeZ 开箱默认 9 插件 + 快照市场 16（偏科金融 10 个）+ 内置 15 + 个人源（本机已直挂 Claude 官方 286 插件目录）。**机制上 FC 个人源更强，观感差距在策展**——补一个 curated 推荐流即可（低成本）。

**结论**："写得更好"总体不成立；成立的是三点：computer-use 确认政策、presentations 工程附件、默认策展广度。FC 独有的是 visual-judge 渲染门、CJK/公文/WPS 深度、诊断族。

## 四、UX 对比（12 项实测盘点）

**FC 已对等或反超**：消息队列（20 键 vs 17，多拖拽排序+暂停三因+resume）、steer（guide/queue 双模式）、草稿持久化（350ms 合并+空快照保结构+跨 workspace 转移）、错误 remedy 动作矩阵（一键重新登录/刷新额度/切模型/降档/带现场反馈）、上下文三源聚合面板（Context+Plan+配额倒计时）、@提及六类 provider、工具渲染器 54 文件+684 键、设置 20 分区、反馈工单中心、ModelTrajectory 轨迹审计。

**真差距五项（按痛度排序）**：
1. **Diff 审查**：仅 unified 无 split、无 hunk 级接受/拒绝（`diff-viewer.tsx:80` 固定）；我们文件级回滚的安全性反而更强（safe/unsafe 预检+原子不写），但"这一处不要"做不到。
2. **折叠 turn 的被拒计数披露**（时长已有，被拒次数分布无）。
3. **关窗/退出枚举活跃任务确认**（logout/更新有，普通关窗无）。
4. **命令面板量级**：~20 条 vs 176 条（骨架已是 Spotlight 形态，缺批量注册）。
5. **终端联动**：agent 执行命令→终端 tab 高亮/跳转（基础设施齐全只差桥接）。

另：系统级 globalShortcut 快窗（0 处引用）、自动审批事后审查卡，列为可选。

## 五、冲突面：不该学的清单（四原则+纯本地过滤）

| 判定 | 机制 | 理由 |
|---|---|---|
| 冲突 | Sparkle 静默更新 | 与"产物不上传"决定冲突；检查器（P0-4）不冲突 |
| 冲突 | 虚拟宠物/Orbit/quickChat 宠物窗 | DESIGN.md 气质对立（calm, dense, operational） |
| 冲突 | WebMCP | 需打 Chromium 补丁=永久跟随负担；扩展路线已有 |
| 冲突 | Guardian 双模型审查 | 摩擦+延迟+成本；静态只读判定已达成目标 |
| 冲突 | 企业 workspace policy / MDM | 无企业面 |
| 冲突 | 云端模型目录（含系统提示模板下发） | 纯本地+构建时嵌入是既定架构 |
| 冲突 | Aeon 云执行 | 等价物已有（background tasks+scheduler+daemon） |
| 改造 | asar integrity/OnlyLoadAppFromAsar | staging repack 与完整性哈希互斥；发布态可做开发态不行 |
| 改造 | 四级确认 | 只取"决策记忆"层并入现有 rules，不引入分级弹窗 |
| 改造 | 审批三档 | 可作会话级预设快捷档吸收进 edit/yolo |
| 适配 | MCP 延迟池/tool_search、hooks mcp_tool、queue revision、goal 预算（goal 面已存在）、压缩阈值参数化（三常量已有） | 均为增量，不碰底色 |
| 适配且已有更优实现 | 工具输出限额 | 我们的"截断必落盘可续读"比 Codex 的纯截断更符合"不丢上下文" |

## 六、修正记录（此前报告的错误与降级）

1. **Q37 队列/steer"缺"→ 误判**：实测 FC 队列 20 键+steer 双模式，反超。已修订。
2. **Q41 草稿"缺"→ 误判**：350ms 持久化+空快照保结构+跨 workspace 转移已存在。已修订。
3. **Q33"技能写得更好"→ 部分误判**：四件套质量同级或更优；仅 computer-use 政策/pptx 附件/策展广度三点成立。已修订。
4. **Q19 压缩 → 对齐**：三常量+失败上限已有。
5. **提升点清单 P0-2 output_token_limit → 降级**：bash 侧已有更优实现（落盘续读），仅 MCP 工具侧值得补。
6. 维持的体验级差距：分发链（Q1-Q3）、流式事件+文件桥（Q8/Q9）、diff 粒度、命令面板、工具-政策绑定（Q18）。

## 七、修订后优先级（收敛后）

**P0（体验级，5 项）**：① 分发链三档（检查器→EdDSA feed→完整签名链）；② 协议流式增量事件+fs 文件桥；③ diff split/hunk 审查；④ MCP 延迟池（接 WIP）；⑤ worktree 落地。
**P1（工程级）**：hooks mcp_tool handler、queue revision 持久化、命令面板批量注册、computer-use 确认政策成文、工具-政策 documents.json 绑定、被拒计数披露+关窗确认（两个小 UX）。
**P2**：goal 预算字段、curated 推荐技能流、市场品类均衡、终端联动、PR 工具集（照 code-review 双 server 分层契约）。
**评估后立项**：安全扫描工作台（Q52，本地 SAST 形态）、模型 JS 内核（node VM 方案）、运行时自包含工具链（Q51，LibreOffice/poppler 钉版本下载通道）。
**明确不做**：第五节冲突表全部。

---

**最终结论**：FreeCodeZ 不缺"好技能"也不缺大部分"好 UX"，它缺的是五件具体的事（分发链、流式协议+文件桥、diff 粒度、命令面板量级、工具-政策绑定）和一件系统性的事（把已有的安全/质量纪律像 Codex 那样**成文化、强制化**——政策文档与工具启用清单级绑定、确认政策写进技能、验证器随技能打包）。后者成本最低，且不改变任何底色。

---

## 附录：三轮全量补查（2026-10-01 终版，9 个子任务）

### A 轮（代码深水区）要点
- **主进程全景**：98 个命名服务 logger（main 80 + bootstrap 18）；AppHost 每窗口服务面约 70 字段；RPC 是自研 **promise-pipelining 框架**（import/export 双对象表+refcount+流直通）；chunked 协议细节：4MiB 内联阈值、2MiB 批、**严格停等 ack**、token 原语 8 类、禁循环引用；AppServer 重连退避 1s 指数翻倍封顶 20s + FNV 确定性抖动 0-500ms + 断网恢复快路径；窗口 appearance 9 种。
- **渲染层命令注册表 139 静态+动态槽位**（recentThread1-6/thread1-9/environmentAction1-9/switchToMode1-3）：命令=id+i18n+availableIn+shortcutScope(app/os-global)+commandMenu 分组+默认键的**纯数据**，默认全员可配快捷键；状态层是自研 atom-store（useSyncExternalStore+immer）；约 50 条路由。
- **概念判定**：whiteboard=**内嵌 Granola 引擎**（granola_workbook/whiteboard/presentation/document 四类型+pane 属性差异更新）；canvas 三义（Mapbox/`.boxcanvas` 文件格式/自研矢量图标格式）；**sides 无产品概念**（纯 CSS 词）；**atlas=内嵌浏览器产品名**（atlas_mode_enabled/set_atlas_as_default_browser/Chrome 迁移检测；公开报道证实 ChatGPT Atlas 浏览器 2026-08 并入桌面应用）；daybreak=网络访问模型族（gpt-daybreak-blue-latest）；skybridge=MCP 托管 app 的 HTML 内容协商（text/html+skybridge）；aeon=常驻主动式宠物助理（thread/startAeon 专用 RPC+外观系统+主动投递）。
- **git-worker**：70+ 消息方法全集；**GitHub 流量 100% 经 gh CLI 子进程，0 处直连 api.github.com**（凭证收敛在宿主，UI 零令牌）；快照=commit-tree+update-ref 的 ref 指针（"Codex host handoff snapshot"），stash 仅恢复期辅助；PR watch 固定 15-300s 节流无退避+headRefOid 前置校验。PR Web UI（13.8MB）：**双层调用回退**（宿主 bridge 快路径→MCP tools/call 慢路径，gh-*↔pull_requests.* 同一注册表双投影）、全功能 MCP 客户端（含 sampling/elicitation）、无 CSP（安全靠宿主壳）、英文单语。

### B 轮（提示词与数据深水区）要点
- **22 个人格全集**（主 agent/多 agent root/subagent/记忆两阶段/Guardian 双形态/Plan 模式/后台执行器/side-conversation/awaiter/explorer 委托规则等）；压缩 prompt 仅 7 行，**"压缩后行为契约"常驻主 system prompt**（分层设计）；Guardian 完整 policy_template：**证据分级（只有 user/developer 消息可信，工具输出一律 untrusted）+ risk×authorization 双轴打分 + 决策矩阵（low/medium 放行、high 需 medium 授权、critical 拒绝）** + `{{tenant_policy_config}}` 注入点；记忆系统 **NO-OP 门**（"Will a future agent plausibly act better…"，全空输出合法且优选）+ "用户说过≠用户偏好"措辞纪律 + memory_summary/MEMORY/rollout_summaries 三层渐进披露；20 条格式纪律句（自包含 final/60 秒评论间隔/最小格式化/文件链接规范/可视化门槛清单）；persistent mode 完整契约全文到手（final 即终止→send_user_message_async 双通道+clock.sleep+Proactivity 段）。
- **提示词运行时**：models_cache.json 是**权威源**（gpt-6-luna 的 instructions_template 与 rollout 快照 sha1 逐字节相等；provenance{type:"model"} 溯源戳；二进制人格是离线兜底）；代际演进 5.5(21,459c 含前端设计大节)→5.6(+token_budget)→6(18,037c 换成技能/插件/连接器生态+confirmation_policies 22.6KB)；"骨架键树+null 槽位"扩展协议；world_state 只存注入文本的 **sha1 哈希引用**（可对账每轮拼了哪份指令）；token 记账六键三维按 turn/thread/response 三粒度。
- **模块→数据表地图**：logs 实际仅 40 target/20 crate（release 部分埋点）；**feedback_log_body 100% 填充=所有日志默认可反馈**；rollout jsonl 是唯一真源，全部 SQLite 是投影（thread_history_projection_state 字节偏移游标增量同步）；state_5 有 **58 条迁移史**；新发现：`codex/sandbox-state-meta` MCP 实验能力、技能检索 A/B（weighted_lexical_v1+CJK 检测）、codex_otel 只记 key 存在性布尔、macOS 托管偏好轮询（MDM config_toml_base64 通道）。

### C 轮（生态与自洽复核）要点
- **依赖披露**：THIRD_PARTY_NOTICES 1408 节/1246 包**全是 npm 层**——Rust crate/Python/Chromium/tectonic/zsh/Granola 引擎全部 0 条目（多层应用单层披露的合规缺口，Granola 引擎许可未披露）；LGPL 仅 2 条（jsxgraph/libheif-js），无 GPL/AGPL。
- **外部事实核对**：openai/codex 公开且 0.159.x 已发布（code-mode-host/voice-host/app-server crate 全部实存）；openai/skills 已废弃→**openai/plugins（62 个插件，含官方 granola 插件**——集成可证、收购无报道）；**插件清单已演进**：`.codex-plugin/plugin.json` 官方定性为"兼容回退"，新标准是根目录便携 manifest（agent-plugins.org schema + extensions.com.openai）；**Electron 42.3.0 官方对应 Chromium 148 而本 app 框架是 154**——证实自定义 Electron 内核，package.json 版本号失真；Sparkle 2.9.1 真实但非最新线（2.10.0）；Codex 桌面 2026 年 2-3 月公开发布、Linux 预览 8 月；MCP 当前规范=2026-07-28，Tasks 已从 related-task 实验键重构为正式扩展 io.modelcontextprotocol/tasks。
- **FC 侧自洽复核**：10 断言核验 7 属实 3 计数偏差（settings 分区实为 **17** 非 20；memory 10 文件非 11；bots 递归 27 非 22——结论方向不变）；4 处文档间矛盾已裁决（早期差距分析 §3.1 误列"自动更新/命令面板/worktree 已对齐"，以终版为准；Sparkle 口径统一为"冲突的是默认静默安装，EdDSA feed+手动触发不冲突"；P0-2 已降级仅 MCP 侧）；**发现被漏掉的自家资产**：packages/formal-proof（产品行为状态空间枚举器——新 spec 的验收基建）、packages/rpc（自有 IPC 框架，P1-6 应对照）、ios/android 模拟器插件（应补入"FC 独有面"）；docs/spec 实为 **15 个**；**关键冲突预警：P0-1 延迟池与 mcp-availability-first-cost-management spec 的 R1/R2 红线正面冲突，动工前必须先修订该 spec（§11-6 预留的 deferred 通道需转正）**；13 个新 spec 建议 + 4 个先行修订清单已归档。

### 覆盖率声明（全部 28 个子任务之后）
已覆盖：应用壳/分发链/签名/fuses/更新、主进程全部 35 bundle、preload 全部 3 个、渲染层结构+i18n 28187 键+命令注册表+路由、插件与技能全部语料（内置 12+运行时 5+系统 5+curated 39+官方插件 15）、codex-cli 二进制（子命令/配置 104 键/协议 ~100 方法+70 通知/**提示词全集**）、cua_node 沙箱、Chromium 框架层、本机运行时全部 SQLite+rollout+日志、外部生态事实核对。**剩余不可覆盖项**：Windows/Linux 构建本体（无安装包）、云端行为（纯本地约束排除）、Rust 函数级反汇编（有开源仓对照，ROI 为负）。静态调查至此封版。

---

## 附录二：破圈轮（2026-10-01，方法升级：运行二进制 + 读开源源码 + 生态实测）

打破"只做静态文件分析"的舒适圈：直接运行 CLI、clone 开源仓读真源码、实测官方市场、拉平台产物。**修正三个此前错误结论 + 一批新发现**。

### 修正记录（以源码/实测为准）
1. **tool_search 延迟池不是本地 BM25**：本地只构建索引文本（工具名+description+schema 递归拼接）并置 defer_loading，真正的检索由 **Responses API 服务端托管工具**执行（tools/tool_search.rs + tool_spec.rs 实证）。对 P0-1 的含义：FreeCodeZ 无服务端托管检索，反而需要**自实现本地检索**（词法匹配即可起步）——更自主也更可行。
2. **openai/plugins 并未迁移到根目录便携 manifest**：62/62 插件全部仍是 `.codex-plugin/plugin.json`，agent-plugins.org schema 只出现在**前瞻文档**中；便携化体现在根目录约定文件自动发现（.mcp.json/.app.json/hooks.json）。FreeCodeZ 插件格式**无需急着迁移**。
3. **"桌面版私有扩展"边界大幅缩小**：开源树含 `codex app` 子命令、app-server-daemon、remoteControl/realtime/userVerification/windowsSandbox——开源版协议 172 方法（65 个 experimental 门控），桌面版差异主要是 UI 壳与打包，非后端私有 fork。此前"Rust 逆向 ROI 为负"的判断再次确认。

### 动态实测新发现
- **协议权威定义到手**：`codex app-server generate-json-schema/generate-ts` 自吐 712KB schema 包（v1+v2、138 类型 TS、ClientRequest 8484 行）——全部 strings 重建从此有 ground truth。存于 codex-app-analysis/protocol/。
- **活进程树**（应用运行中实测）：主进程 → GPU/网络/存储 Service + 渲染器×N + bare-modifier-monitor（`--key DoubleCommand --immediate` 双击⌘）+ app-server；app-server → cua-repl→嵌套 node_repl + 两个 server.mjs（codex-app-tools 与 code-review，后者由 `-c plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=true` per-turn 覆盖键拉起——静态推断的配置机制被实测证实）+ node_repl；主进程 → SkyComputerUseService。
- **features 权威清单**：`codex features list` 输出 stage（stable/experimental/under development/**removed**）+生效态；removed 态纠正 strings 推断（elevated_windows_sandbox 等已删）。
- **codex doctor**：自检环境/端点保护/安装一致性/磁盘阈值/更新可达——zcode-guide 诊断技能族的**可执行版**，FreeCodeZ 可直接立一个 `doctor` 命令（新提升点，成本低）。

### 源码级新发现（openai/codex @ main）
- **提示词模板化**：prompts/templates/ 21 个 .md 文件 include_str! 编入（compact 9 行/guardian 4 件套/review rubric 96 行含 P0-P3+JSON schema/沙箱 3 档注入块/审批 4 策略块）；persistent_mode.md 带 `{{approval_request_channel}}` jinja 变量。
- **hooks**：12 事件证实；**prompt/agent 两个 handler 枚举存在但未实现**（discovery 直接 skip）；SessionEnd/Interrupt 超时 1-3s 钳制、其余默认 600s；trusted_hash 按**归一化 handler 身份**哈希（等价配置收敛同一信任身份）；additionalContextLimit 默认 2500 token 溢写磁盘。
- **沙箱实为 4 档**（+external-sandbox）；protected metadata 四名（.git/.agents/.codex/.aws）防 mkdir 首建；fcntl 80/110 deny 堵只读 fd 写漏洞；可写根 symlink 报错策略；网络解析失败=fail-closed 断网。
- **agent-plugin 工具 spec 预算**：单工具 8KB/总 64KB，超限直接 Hidden——MCP 治理的又一档（比 schemaLarge 标注更硬）。
- **测试面**：18353 处 #[test]；app-server v2 集成测试 162 个；沙箱按平台逐特性单测（fcntl/daemon socket/TLS）；hooks schema JSON fixture 快照。
- **exec 与 app-server 同管线**（非旁路）；unified_exec 是 yield 软超时模型（250-30000ms）+ 审批决策缓存。

### 生态实测新发现（openai/plugins @ main + releases）
- **市场结构**：62 插件/10 官方品类/535 个 SKILL.md；**91% 技能带 agents/ 子目录**（subagent yaml 是生态范式）；hooks 几乎不用（62 个仅 figma 1 个 PostToolUse 写后设计一致性检查）；**.app.json OAuth 连接器是第一大形态（37/62，云端绑定），FreeCodeZ 无对应机制**；plugin.lock.json 第三方技能 vendoring+sha256 溯源锁（figma/notion 在用）。
- **FreeCodeZ 品类空白实测**（快照 26 个非 16，实际仅 3 品类）：完全空白 6 个品类——Creativity(9 生态位)/Communication(5)/Education&Research(4)/Data&Analytics(3)/Scientific/Business&Operations；Finance 反向碾压（14 vs 2）。**"app 连接器"与"品类空白"是市场侧两个真实提升点。**
- **发布工程**：单日 5 个 alpha、每 release 176 assets、release notes 全空（说明外移文档站）；**bwrap 是 Rust 自写重写版（244KB 独立产物+sigstore）**；Windows 沙箱=**WFP 内核过滤+MSIX 包身份+deny-read ACL+双进程服务**（非注册表面）；Linux 现行=**bwrap mount ns+seccomp（deny ptrace/io_uring/WSL2 VM socket），Landlock 已降级 legacy**。
- **hooks 事实标准**：Codex hooks 与 Claude Code 事件名/matcher/exit 2/stdin JSON/updatedInput **逐一同构**（未宣传兼容）——FreeCodeZ 采用同构契约=零成本接入两大生态的现成 hook 脚本。
- **文档站迁址** learn.chatgpt.com；产品页营销零安全字眼（"文档极简、实现极重"）。

### 破圈轮对提升点清单的修订
- P0-1 修订：本地自实现检索（服务端托管不可依赖），起步用词法匹配。
- 新增 P2-7：`zcode doctor` 可执行自检命令（对齐 zcode-guide 技能族）。
- 新增 P2-8：插件市场补 .app.json 式 OAuth 连接器机制 + 6 个空白品类引入 + plugin.lock 式 vendoring 锁。
- P1-1 强化：hooks 契约直接对齐 Claude Code/Codex 事实标准（生态复用）；补 prompt/agent handler 为"预留枚举"即可（官方也未实现）。
- 新增（评估）：PermissionProfile 序列化 JSON 一等公民（config→CLI→沙箱 helper 全链路同一份）；沙箱 hardening 候选——**FC E 批已有三平台沙箱**（seatbelt 真机校准/bwrap/Windows MIC），增量方向是 Codex 源码轮发现的防护细节：protected metadata 四名（.git/.agents/.codex/.aws）防 mkdir 首建、fcntl 80/110 deny、网络解析失败 fail-closed 断网、helper 独立产物化。

---

## 附录三：项目全记录对照修正（2026-10-03，依据《项目全记录-FreeCodeZ-从ZCodefork到现状.md》40 笔提交史）

阅读用户整理的全记录后，本报告此前有三处判定过时，修正如下：

1. **沙箱**：此前多处将"OS 级三平台沙箱"列为 Codex 独有/FC 评估档——**错**。FC 能力提升 E 批已落地自研三平台沙箱（macOS seatbelt 真机逐项校准含反 codex 教训：.git 保持可写；Linux bwrap 上古稳定旗标；Windows 低完整级 MIC 真机验证前 UI 锁定），且激活语义有唯一权威入口。差距收敛为 hardening 候选（protected metadata/fcntl deny/网络 fail-closed/helper 产物化）。
2. **yolo 安全模型**：此前只归功"静态只读判定"——不完整。FC 另有**灾难形态地板**（四类封闭清单，拦形态不拦命令名，16 合法近邻零误杀+15 灾难命中测试）与**无人值守审批超时 120s**（根治 cron 挂死）、cron 强制显式 mode。权限/安全行已按此更新（见 §二矩阵）。
3. **MCP 成本治理**：记忆口径"MCP 零护栏"已被第六阶段（27029fc 观测层：denylist/visibility/目录缓存/token 徽章）与第七阶段 B 批（token 卫生：CJK×3÷4 统一估算、43 工具实测 18.5K token、无色化、截断对称）取代——观测层已落地，控制层第三态（延迟池）即决策点 4，与提升点 P0-1 对应（动工前先修 spec 红线）。
4. **输入队列持久化（2026-10-03 二次修正，用户观察触发）**：此前两处文档（问题手册 Q22、提升点 P1-4）称"CommandInbox 内存态、重启丢消息"——**错**。代码实证 `session-inputs.ts`：SQLite 账本、admitted→promoted 状态机、`admitted_sequence` 编号、promotion 与 user message **同事务**（孤儿窗口已修）。此差距项撤销，仅余 goal 预算+待续位（P2-1）。教训：子代理"内存态"为推断未核实源码，用户一手观察优先。
5. **全面复审（2026-10-03，用户质疑触发，逐条对代码审计 12 项断言）**：再推翻 2 项、修正 3 项——①**"无 token 级流式"错**：`model.streaming` 事件（delta/partId/kind）+ zcodeSessionEventCoalescer 合并器 + 渲染层 delta 消费，流式管线已存在（Q8 已修，降级 ✓/★）；②**"审批缺回执"错**：permission.requested/resolved 事件对均带 requestId，payload 含 riskLevel 四档，另有 interaction/requestPermission 方法（Q10 已修）；③**"浏览器缺政策文档"半错**：browser-use 插件已有 documents.json 门控机制 + docs/safety.md 等 8+ 篇——**机制已有、内容薄**（safety.md 7 行 vs Codex confirmations 5.8KB 四级政策），差距收敛为"内容补深"；④Appshot 差距修正：composer 已有 CUA 常驻入口（控制电脑），缺的只是"截图+文字喂给对话"形态与全局热键；⑤**站得住的**：无更新通道（no-op 实证）、diff 仅 unified 且无 hunk 操作、worktree throw、PR 无专用工具、MCP 无第三档、Word/Excel 活控与修订脚本缺口、doctor 命令无、命令面板 18 条、市场品类偏科、fs 桥无。**P0 集合修订**：原"流式事件+审批回执"撤出 P0，P0 收敛为——分发链、diff 审查粒度、MCP 第三档、worktree/PR、fs 桥（新增，协议方法实证缺失）。

**全记录与提升点清单的对齐**：遗留 #4（安装包未签名）= P0-4/P0-5 分发链三档；决策点 4（MCP 懒加载）= P0-1（已有 ~T tk 观测数据在积累，具备裁决条件）；决策点 5（code-mode GLM 复跑）= P3-1 JS 内核评估档；E 批沙箱 = 本附录第 1 条修正。FC 独有面清单另可扩充（全记录已列：goal 外部完成验证器、diff 行数统计、compact 时间线六态）。
