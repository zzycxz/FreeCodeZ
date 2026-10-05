# FreeCodeZ 提升点清单（基于 Codex 桌面应用机制级拆解）

- 日期：2026-09-30。前置报告：[差距分析-FreeCodeZ-vs-OpenAI-Codex桌面应用-全面清查.md](./差距分析-FreeCodeZ-vs-OpenAI-Codex桌面应用-全面清查.md)
- 约束：**FreeCodeZ 是纯本地应用**——云侧机制（Aeon、连接器、Statsig、服务端语音模型、MDM 企业管控）一律剔除；每条按用户四原则（安全不添麻烦 / 不丢上下文 / 不做熔断 / 无常驻 shell）过滤。
- 方法：Codex 侧函数级证据（解包产物 `~/Desktop/swarm-os/codex-app-analysis/app` + 二进制 strings + `~/.codex` schema）× FreeCodeZ 现状（仓库盘点），只列**本地可实现且 FreeCodeZ 还没有/没做完**的交集。

## 总览（按建议优先级）

| # | 提升点 | 依托的 FreeCodeZ 现状 | Codex 证据 |
|---|---|---|---|
| P0-1 | MCP 工具"延迟池 + 按需检索"（大目录 server 不占 system prompt） | 工具级可见性 WIP（disabledTools + token 估算 + 目录缓存） | `omit_tools_from: deferred` + `tool_search` feature flags |
| P0-2 | 按工具 `output_token_limit` 执行期截断 | WIP 只有估算展示，无执行期上限 | `tools.<name>.output_token_limit`（js 工具 25000） |
| P0-3 | git worktree 隔离运行时落地 | schema 有 `worktree` 枚举但运行时 throw | git-worker：snapshot/snapshotBranch/PR 全流程 |
| P0-4 | 桌面更新检查器（非静默安装） | autoUpdater 是 no-op 空壳 | Sparkle EdDSA appcast + `check-for-updates` |
| P1-1 | hooks 增补 `mcp_tool` handler + 决策语义 | hooks 信任链已有（SHA256 双摘要） | 12 事件 × command/mcp_tool 双 handler |
| P1-2 | 全局热键快速浮窗 | quickpick 仅应用内 | quickChat 窗型 + `default-quick-chat-hotkey` |
| P1-3 | MCP server `env_vars` 声明式白名单透传 | MCP 子进程疑似全量继承 env | code-review 22 变量白名单 |
| P1-4 | 会话输入队列持久化 + revision 水位 | CommandInbox 串行 admission（内存态） | queue_1.sqlite 三触发器单调 revision |
| P2-1 | goal 挂预算 + "待续跑"原子位 | session/goal 协议已有 | thread_goals + continuation_deferrals |
| P2-2 | 工具目录缓存落盘 + 哈希完整性 | WIP 缓存刻意不落盘（30min TTL） | plugins/cache + integrity.json(sha256) |
| P2-3 | skill `$` 提及通道（输入+输出双向） | skill 门控/指针描述已有 | ProseMirror skillMention + custom_symbol_offsets |
| P2-4 | `.skill` 文件类型 + 推荐 skill 安装 | 设置页/市场/远程同步已有 | vnd.openai.codex.skill + install-recommended-skill |
| P2-5 | 重运行时按需下载通道 | pdf/pptx 等靠外部技能 | ~/.cache/codex-runtimes + runtime.json |
| P3-1 | 给模型的沙箱 JS 内核（code-mode 效果） | 无对应（workflow 是编排不是内核） | node_repl cell 模型 + V8 沙箱 |
| P3-2 | LSP 运行时自安装 | 无 | kotlin-server/rust-analyzer/ty 安装器 |
| P3-3 | shell 快照安全加固 | 快照机制已有（bash-shell-snapshot 三处） | command -p 防劫持 + 凭据扫描拒绝 |

---

## P0：直接补空白 / 接 WIP

### P0-1 MCP 工具延迟池 + 按需检索（deferred tool pool + tool search）

- **效果**：接入几十个工具的大 MCP server 不再撑爆 system prompt——默认只注入 server 名 + 描述 + 检索工具，模型按需 `tool_search` 拉取具体工具 schema。
- **Codex 证据**：`omit_tools_from: ["deferred"]`（unified-computer-use、codex-app-tools 的 .mcp.json）；Rust `ToolExposure::Surface | Deferred` 二元组；feature flags `tool_search`、`tool_search_always_defer_mcp_tools`、`deferred_tool_world_state`。
- **FreeCodeZ 现状**：WIP（`packages/shared/src/mcp.ts` + `tool-catalog-cache.ts` + `McpServerToolsDialog.tsx`）已做逐工具可见性开关、`~tk` 成本估算、`schemaLarge(>4096B)` 标注、进程内 LRU 目录缓存——恰好缺"第三态：可见但不注入，检索后注入"。
- **移植方案**：在现有 `mcpToolModelVisible` 纯函数上加 `exposure: 'surface' | 'deferred'`（按 server 级默认 + 工具级覆盖，schema 超大工具自动 deferred）；注入层（`dynamic-sections.ts`）把 deferred 池压成一行目录；新增一个内置 `tool_search` 工具查缓存目录并临时挂载。
- **原则符合**：不丢上下文（工具能力仍可达）；不添麻烦（默认规则自动分层，用户不用逐个关）。

### P0-2 按工具 output_token_limit

- **效果**：单工具输出超限截断，防一条 5 万 token 的工具结果吃掉预算。
- **Codex 证据**：`tools.js.output_token_limit: 25000`（unified-computer-use .mcp.json）；由 codex CLI 在 tools/call 路径消费（宿主构建中 0 命中，说明在 agent 侧执行）。
- **FreeCodeZ 现状**：WIP 的 `estimateMcpToolTokens` 只估 schema 注入成本，不管输出。
- **移植方案**：`McpServerConfig.tools[name].outputTokenLimit`；adapters 层 tools/call 返回后按 token 截断 + 追加"已截断，可用参数收窄重试"提示。与 P0-1 共用 per-tool 配置面。

### P0-3 worktree 隔离运行时

- **效果**：并行任务互不踩踏；"试验树/基准树"工作流（你们三树定位）天然需要。
- **Codex 证据**：git-worker（worker_threads，`worker.js` 2.37MB）：`git-init-repo/git-origins/snapshot/snapshotBranch/github-request/createPullRequest(AsDraft)/mergePullRequest`；配置键 `git-commit-instructions`、`git-create-pull-request-as-draft`、`git-review-mode`。
- **FreeCodeZ 现状**：`z.enum(["worktree"])` 占位，`script-workflow-runtime.ts:282` 直接 throw "not implemented yet"。
- **移植方案**：先做最小闭环——workflow run 启动时 `git worktree add` + 完成后快照（branch 指针）+ 清理策略；PR 交互仍走 bash+gh，不必先做 worker 线程。

### P0-4 桌面更新检查器

- **效果**：用户知道有新版，一键跳 Release 页；不做静默安装。
- **Codex 证据**：Sparkle + EdDSA 签名 appcast + `codex_desktop:check-for-updates` IPC + "更新会中断本机活动会话"确认文案。
- **FreeCodeZ 现状**：autoUpdater 八函数 no-op 空壳（`packages/desktop/src/main/index.ts:78-95`），发布走 GitHub Release 手动打包。
- **移植方案**：不引 Sparkle——定时 GET Release latest API 比对版本号即可（网络客户端你已有）；UI 用现有 `useDesktopUpdateMenu` 空转 hook 复活。若后续要静默更新再上签名 appcast。

## P1：体系增强

### P1-1 hooks：补 `mcp_tool` handler 与决策语义

- **效果**：① hook 不必 spawn shell（无常驻 shell 原则的正解）；② hook 可短路权限弹窗（安全不添麻烦：可信规则自动 allow）；③ PostToolUse 可注入 additionalContext 而不重跑。
- **Codex 证据**（全部来自 codex 二进制 strings + plugin.json 实例）：
  - 12 事件：PreToolUse / PermissionRequest / PostToolUse / PreCompact / PostCompact / SessionStart / SessionEnd / UserPromptSubmit / SubagentStart / SubagentStop / Stop / Interrupt；
  - handler 双类型：`command`（timeout/async/statusMessage）与 `mcp_tool`（server+input 模板 `${hook_event_name}/${session_id}/${agent_id}/${turn_id}/${tool_name}/${tool_input}`）；
  - 决策 schema 严格白名单：PreToolUse→`permissionDecision: allow|deny|ask`（deny 必带 reason；`updatedInput` 仅 allow 时允许；保留字段出现即 fail-closed）；PostToolUse→`decision:block + reason + additionalContext`；
  - SessionEnd/Interrupt 前先 flush transcript。
- **FreeCodeZ 现状**：hooks 信任链完整（`workspace/hooks/trustGrant` + SHA256 bundle/declaration 双摘要 + 6 reasonCode + 投影），比 Codex 的 trusted_hash 更细；缺 handler 类型扩展与决策输出语义。
- **移植方案**：协议侧 `zcode-protocol` hooks 声明加 handler 类型和决策输出 schema（沿用你们的 zod 严格校验风格）；执行侧在 CLI runtime 的 hook engine 加 mcp_tool 分支（复用 MCP client 连接池）。

### P1-2 全局热键快速浮窗

- **效果**：任何时候热键唤起迷你输入窗（quick prompt），投递到当前 workspace 的会话队列。
- **Codex 证据**：`appearance:'quickChat'` 窗型 + `default-quick-chat-hotkey` + `hotkey-window-home-placement` 配置。
- **FreeCodeZ 现状**：无 globalShortcut（grep 零命中）；quickpick/CommandCenter 是应用内。
- **移植方案**：Electron globalShortcut + 无边框小窗 + 复用 CommandInbox 投递路径；与手机远控共用"会话队列"语义。

### P1-3 MCP env 白名单

- **Codex 证据**：`.mcp.json` 的 `env_vars: string[]`（code-review 列 22 个：GH_TOKEN、代理、NODE_EXTRA_CA_CERTS…），宿主只注入白名单。
- **FreeCodeZ 现状/方案**：`McpServerConfig` 加 `envAllowlist`，adapters spawn 时构造最小 env（PATH/HOME + 白名单）。默认空 = 只给基础变量，防 MCP server 拿到宿主全部环境（含 API key）。

### P1-4 会话输入队列持久化（2026-10-03 撤销：已对齐且更优）

- **撤销说明**：~~此前误判"CommandInbox 内存态、重启丢消息"~~。代码实证 `session-inputs.ts`：SQLite 账本（admitted→promoted 状态机 + admitted_sequence 编号 + promotion 与 user message 同事务，孤儿窗口已修复）——Codex 的 queued_items+revision 触发器方案已有等价且原子性更强的实现。本项从清单撤销；goal 预算+待续位保留为 P2-1。

## P2：渐进增强

- **P2-1 goal 预算 + 待续位**：Codex `thread_goals` 带 `token_budget/time_used_seconds` 与 `status(usage_limited/budget_limited)`；`thread_goal_continuation_deferrals` 是只有 thread_id 的空表=原子"待续跑"标志（CASCADE 删除）。FreeCodeZ 已有 session/goal + goalStats——补"预算字段 + 重启后检测待续位自动提示续跑"，就是本地过夜任务的最小实现（不丢上下文）。
- **P2-2 目录缓存落盘**：WIP 缓存不落盘（30min TTL）。Codex 物化缓存模式：内容+sha256 的 integrity.json，启动时哈希校验后直接用，冷启动零 tools/list 往返。落到 `~/.freecodez/cli/db/` 旁即可。
- **P2-3 skill `$` 提及**：Codex composer 有 `$skill` / `@plugin` mention 节点，且模型输出经 `custom_symbol_offsets` 重建 `$name` 标记（双向）；`getMentionedSkillPathsKey()` 只传 path 不传正文。FreeCodeZ 的 skill 门控已具备服务端条件，缺 composer 侧显式提及 UI——做后可让"必须用某 skill"变成一键、省掉描述路由的不确定性。
- **P2-4 `.skill` 文件类型**：注册 `application/vnd.freecodez.skill`，双击→校验 frontmatter→原子安装到 user skills 根（已存在则 abort，cp→rename 原子替换 + 旧版挪 `.tmp` 备份 + path-traversal 校验）。配套"推荐 skill"列表（vendor_imports 模式）。
- **P2-5 重运行时下载通道**：Codex 把 tectonic/TeX Live/LSP 装到 `~/.cache/codex-runtimes/<runtime>/` + runtime.json（逐文件 sha256 + sources.json 溯源）。FreeCodeZ 的 pdf/pptx/xlsx 技能依赖外部工具时同样卡安装——做一个 per-runtime 的下载/校验/PATH 注入器，技能声明 `runtime: latex` 即用。

## P3：大件（评估后立项）

- **P3-1 模型 JS 内核**：Codex node_repl = Rust/V8 沙箱 + cell 模型（顶层绑定可重声明、`js_add_node_module_dir` 与 kernel 生命周期解耦、超时=kernel reset+提示重跑、`emitImage/emitAudio`、活跃执行注册表落盘、trusted-service 单通道 RPC、env 白名单+清洗 `NODE_OPTIONS/LD_PRELOAD/DYLD_*`）。效果=模型获得无 shell 的计算/数据处理/图像处理能力，与无常驻 shell 原则完全同向。FreeCodeZ 自带 Node 运行时（桌面/CLI 都是 TS 栈），实现成本低于 Codex（不需要 V8 嵌入，用 `node --experimental-vm-modules` VM 即可，node_repl 的 kernel.js 就是这么做的）。可先做只读数据加工面（sharp/pixelmatch 那类），审批走现有 permission 体系。
- **P3-2 LSP 自安装**：rust-analyzer/ty/kotlin-server 按需装到 runtime 通道（同 P2-5），给模型符号级代码智能。优先级低于 JS 内核。
- **P3-3 快照加固**：现有 bash-shell-snapshot 补三点——捕获工具用 `command -p` 防 rc 内函数劫持；快照落盘前扫描凭据模式（Codex：发现 brokered credential 直接拒绝）；大小上限 + NUL 分节防污染。

## 明确不移植（本地定位/原则冲突）

云执行后端 Aeon、连接器生态、Statsig 灰度、服务端语音模型（本地做语音需另立 whisper 方案，不在本清单）、devicecheck/远程证明、MDM 企业策略、默认浏览器注册、Codex Micro 硬件、虚拟宠物、Intel 警告、MSIX/deb/rpm 矩阵（单平台手动发布够用）。另：Codex 审批三档里的 `writes`（读写分档）依赖工具 annotations 的准确标注，MCP 生态标注参差，FreeCodeZ 的 plan/edit/yolo 模式已覆盖同等效果，不必改。

## 第二轮新增（DMG 安装包 + preload 层视角，2026-10-01）

### P0-5 分发链整体补课（FreeCodeZ 打包默认未签名，这是最大的体验差距之一）

- **Codex 证据**：Developer ID + 公证 + stapler 装订（离线过 Gatekeeper）；AKV 云密钥 profile（有效期 2044）；fuses 全量加固（`RunAsNode off`/`NODE_OPTIONS off`/`--inspect off`/**asar 完整性校验 on**/`OnlyLoadAppFromAsar on`/Cookie 加密 on）；**Sparkle 增量更新：12404→12553 delta 仅 2.26MB（全量 682MB，300 倍缩减），delta 回溯 5 版本、逐个 EdDSA 签名、日更节奏**；DMG 专业装帧（卷图标/背景/Applications 链接）；arm64/Intel 分架构构建。
- **FreeCodeZ 现状**：打包产物默认未签名（`pnpm bundle:desktop` 手动分发）；autoUpdater 空壳。
- **移植方案（递进三档）**：① 最小档——P0-4 的版本检查器；② 中档——引入 Sparkle（EdDSA 应用层签名**不要求** Developer ID，GitHub Release 托管 appcast.xml 即可），带 delta（`go-xdelta`/binary-diff 或直接全量 zip 也能用）；③ 完整档——Developer ID 签名 + notarytool 公证 + stapler + fuses 加固（`@electron/fuses` 已在你们 node_modules）。asar integrity 开关对 fork 自定义加载路径有影响，需单独验证。

### P0-6 "Owl 式"主进程网络权限沙箱

- **Codex 证据**：startup-requirements 的 `Xi()`——主进程剔除 argv 全部权限参数与 NODE_OPTIONS 后以 `--codex-node-network-restricted --allow-fs-read=* --allow-fs-write=* --allow-addons --allow-child-process --allow-worker --allow-ipc=<home>` 自 relaunch，重启后断言 `process.permission.has('net')===false`，否则拒绝启动；URL 门禁仅放行 app:/codex-sandbox:/data:/file: 与 https allowlist。
- **效果**：主进程/插件的供应链外泄被操作系统级禁网拦截，用户零感知（安全不添麻烦的极致形态）。
- **FreeCodeZ 现状**：主进程无 Node permission model 限网。
- **移植方案**：FreeCodeZ 主进程与外部网络交互面有限（远控 relay、市场、模型 API 多在 CLI 侧），可先对**桌面主进程**做：检测到不需要出网的窗口/模块时以 permission model 重启；CLI 侧网络是刚需（模型 API），不适用。属"评估后立项"级。

### P1-5 双击修饰键唤起（比组合热键更不打扰）

- **Codex 证据**：bare-modifier-monitor 原生模块（DoubleModifierMonitorSession/ReleaseModifierMonitor/BareModifierKey）——双击 Cmd/Option 唤起 quickChat 浮窗，无需记忆组合键。
- **移植方案**：与 P1-2 全局浮窗合并实现，CGEventTap 双击修饰键检测（macOS）+ 对应 Windows SetWindowsHookEx 方案。

### P1-6 chunked-message 流式 token 协议（大对象边收边渲染）

- **Codex 证据**：`codex-host-chunked-message-v1`——主→渲染器不走整包 JSON.parse，而是 array-start/object-start/string-chunk 等 token 原语流 + 逐序 ack。
- **FreeCodeZ 现状**：你们在 workflowRuns 已有 delta op-log（同思想、O(N) 修复），但通用"主→渲染器大对象流式化"没有。
- **移植方案**：可作为长会话历史/大 catalog 首屏的渲染加速项；优先级低于 P0 组。

### P2-6 MCP Tasks 扩展（长任务异步轮询）

- **Codex 证据**：`io.modelcontextprotocol/related-task`（tasks/get/result/list/cancel + status 通知：working/input_required/completed/failed/cancelled）已进桌面协议层——工具调用从"同步等结果"升级为"提交任务+轮询/通知"。
- **FreeCodeZ 现状**：offPeak/cron/automation 已有异步面，但 MCP 工具调用是同步模型。
- **移植方案**：协议层预留 `zcode-protocol` 的 task 扩展（对齐 MCP 规范动向），供慢工具（大规模扫描/构建）使用。

### 前瞻项（记录不立项）

- **WebMCP 站点直通**（网站经 `document.modelContext` 注册为 MCP 工具提供方，上限 100 工具/64KB）：依赖 Chromium 154 的实验特性，Electron 版本跟进后可在 FreeCodeZ browserView 上开同款 flag。
- **站点注解 API**（面向第三方网站作者的公开 DOM API，评论/设计审查集成协议）：产品方向决策，非技术缺口。
- **Codex Micro 实体键盘**（HID 六键槽位 RGB/摇杆/电池）：无硬件则无意义，仅存档其实现规模（29KB service + 1 个原生 addon）。

## 与四原则的对齐说明

- **安全不添麻烦**：P0-1/P0-2/P1-3 都是"配置一次、自动生效"的静默安全；P1-1 的 hook 决策让可信规则替代重复弹窗。
- **不丢上下文**：P1-4/P2-1/P2-2 直接对应（队列不丢、续跑不丢、冷启动不重算）；P0-1 的检索池保证能力可达性。
- **不做熔断**：全清单无"失败即禁用"逻辑；output_token_limit 是截断+提示重试，不是断路。
- **无常驻 shell**：P1-1 mcp_tool handler、P3-1 JS 内核、P3-3 快照数据文件化，三个方向都在消解 shell 常驻。
