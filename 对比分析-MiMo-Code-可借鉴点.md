# MiMo-Code vs FreeCodeZ 对比分析（2026-09-30）

> 标尺：效果优先，不照抄机制。先核对 FreeCodeZ 已有能力，再列真正值得借鉴的点。
> MiMo-Code = 小米基于 OpenCode 的 fork（Bun + Effect + QuickJS，终端 TUI 产品），
> FreeCodeZ = 基于 ZCode 的桌面/CLI 产品（Electron + Node，多宿主 + 手机远控 + Bot）。
> 谱系不同，架构不可直接照搬；本文只取**效果层面**可迁移的设计。

---

## 一、已对齐，无需再学的（防止误判为差距）

| 能力 | MiMo-Code | FreeCodeZ 现状 |
|---|---|---|
| 跨会话项目记忆 | MEMORY.md + checkpoint.md + SQLite FTS5 | **已有**：`core/src/memory/` 全套 auto-memory（MEMORY.md 注入 + 后台抽取 agent + manifest 去重），`memoryEnabled` 开关 |
| 上下文压缩 | 溢出时 rebuild/compaction | **已有**：auto + manual + microcompact + 边界持久化恢复（`core/src/compact/`） |
| 确定性 workflow 引擎 | QuickJS 沙箱 + journal 重放 | **已有且更完备**：`packages/dynamic-workflow/` 脚本引擎（类型化子代理、门控循环、journal、amend/resume/retune、崩溃恢复），FreeCodeZ 还多出审批门与 428 skill 门控 |
| 子代理系统 | actor spawn/peer/fork-context | **已有**：Agent 工具 + 后台执行 + SendMessage/TaskOutput + 用户自定义 profile |
| 目标停止判定（judge） | /goal + 冷判官 + 拒绝理由回灌 | **已有**：`target-completion-verification.ts`，验证失败原因经 `formatGoalContinuationPrompt` 回灌下一轮（同思路），fail-open 也有 |
| MCP 工具级开关 | — | **进行中**（工作区未提交）：McpServerToolsDialog + disabledTools 组装过滤 + catalog 缓存 |
| serve/attach 远程 | mimo serve/attach | **已有**：serve --daemon + 手机远控 + Bot 双通道（FreeCodeZ 独有优势面） |

结论：MiMo-Code 的"记忆/压缩/workflow/子代理/目标判定"五大件，FreeCodeZ 在效果层面全部已有对应物。真正值得学的是下面这些**增量设计**。

---

## 二、值得借鉴的点（按性价比排序）

### P1-1 每模型压缩预算（/context-limit）——最便宜的赢

**MiMo 效果**：`compaction.max_context` 支持标量或 `"<provider>/<model>"` 通配 map（如 `"anthropic/*": "300K"`），值可写 `300000 / "300K" / "1M" / "50%"`；**只能下调不能上调**（clamp 到供应商窗口），`0` 作为"恢复默认"哨兵（因为 config merge 删不掉键），非法值每键 warn-once。动机是真实成本问题：超过计费档位（如 272K 以上 2x 计费）提前压缩更省钱，且"标称窗口 ≠ 实际可用窗口"（订阅/直连/中转路由不同）。UI 上 `/context-limit` 对话框写入 user-global config，会话忙时拒绝写入。

**FreeCodeZ 落点**：`compact/policy.ts:23` 已定义 `thresholdPercentOverride` 但 **line 101 写死 `DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT = 100`，未接线**，且设置 UI 无此选项。等于管线已通、只差最后一段。借鉴点：
- 接线现有字段，扩展为每模型 map + 通配 + 单向下调 clamp + `0` 哨兵；
- 设置页加"上下文预算"入口（桌面端比 TUI 更好放）；
- 状态栏 token 显示分母用生效预算并标记（MiMo 用 `↓` 标记预算生效中）。

**工作量**：小。协议/UI 各加一处，核心是 policy.ts 一处解析。对走中转/免费模型的 FreeCodeZ 用户，"提前压缩省钱"是刚需。

### P1-2 内置 workflow 模板库——引擎完备但零模板

**MiMo 效果**：引擎只做执行，价值在随附 4 个久经打磨的内置 workflow（`.mimocode/workflows/<同名>.js` 可覆盖内置）：
- `compose`：brainstorm → design → Kahn 拓扑排序分批 → 批内 >1 自动 worktree 隔离 → 集成 → verify → TDD 外环 ≤3 → review → fix ≤2 → report → merge；
- `deep-research`：brief → 规划角度（schema）→ 并行调研写 `findings/F<n>.md` → 补漏轮 → 单一写手成稿 → 冷评审 → 条件修复。**每阶段用 `exists(file)` 做幂等门——文件系统即断点续跑状态**；
- `fact-check`：并行检索 → 抽取可核查断言 → 去重分组 → 3 陪审员对抗投票；
- `research-experiment`：可机械验证指标的自主优化环，keep/revert 由**脚本比较数字**决定（不信 LLM 自评），带 3 败 REFINE / 5 败 PIVOT 的脚本级升级阶梯和"作弊审计"。

**FreeCodeZ 落点**：dynamic-workflow 引擎能力覆盖以上全部（门控循环、并行、journal、resume），但**只随附 authoring skill，无内置模板**。借鉴动作：
- 把 4 个模板改编为 FreeCodeZ facade API 的 saved workflows（`.zcode/workflows/` 机制已有，全局库 `~/.freecodez/workflows/` 已有）；
- 移植两个编排习语：**文件存在性即阶段门**（天然幂等 + resume）、**keep/revert 由代码判数字而非模型自评**。

**工作量**：中（内容改编，无引擎改动）。效果立竿见影：workflow 功能从"能写"变成"开箱能用"。

### P2-1 skill 预排序：BM25 + 精确别名双层 + 中文友好

**MiMo 效果**：新任务先在 skill 清单上跑检索再决定注入：
- 精确层：名称/别名/**本地化别名**命中（词边界匹配，汉字用包含匹配）得 1.0 分——本地化别名直接从 TUI i18n 词典收割（`tui.skill.<name>.slash` 条目），零新增元数据获得中文触发能力；
- BM25 层：**汉字切 character-bigram**（无需分词器）、拉丁词去复数 s、停用词表兼作"模板降噪器"；最终分 = `0.55×(BM25/max) + 0.35×查询覆盖率`，天花板故意压在 0.90 < 精确层 1.0；
- ≥0.85 自动加载注入正文，否则只返回带命中理由的排名 JSON 交给模型判断——"自信就注入，不确定就让模型决定"；
- **一条消息提到 ≥2 个 skill 时，强制先产出多 skill 编排计划**（pipeline / parallel / constraint-overlay 三分类 + 中间产物接口约定 + 冲突优先级声明），正文注入上限 3 个。

**FreeCodeZ 落点**：现状是纯模型侧 description 匹配，全部 skill 按**字母序**平铺注入（`context/sections/skills.ts`，20K 字符预算兜底）。借鉴点分层：
- 最便宜且独立：**多 skill 编排计划提醒**——纯 prompt 层改动，直接减少 skill 互相踩踏；
- 中等：BM25 预排序用于排序注入顺序（高频命中靠前）+ zh-CN locale 收割中文别名（FreeCodeZ 本就是中文用户为主的 fork，中文查询触发英文 skill 是真实痛点）；
- 注意与已有三层护栏（250 字符描述 / 20K 字符节 / 100KB 正文）叠加时不破坏现有预算。

**工作量**：编排提醒小；BM25+别名中。

### P2-2 重复环检测：把 max-mode 的 n-gram 监视器移植为 yolo/cron 巡航预警

**MiMo 效果**：max-mode 给每个候选流挂 `createTextNgramMonitor`，文本重复环立即识别为 `text-repeat` 并中止该步。机制本身与 max-mode 无关，是个独立的"输出打转检测器"。

**FreeCodeZ 落点**：已知的变形风险面——**bots yolo/cron 挂死**（记忆中已标注待处理），现状只有范围/配额防护（20 个保留任务上限、automation turn 变更拒绝等），**无打转检测**。借鉴动作：在 turn-loop 对 assistant 输出做 n-gram 重复检测，命中后**注入纠正性 system-reminder（"你在重复 X，换个方法"）而非终止**——这正符合"不做熔断、安全不添麻烦"的设计原则。goal continuation 循环目前 `while (!aborted)` 无重入上限，可顺带加"同一拒绝理由连续 N 次 → 停止并向用户汇报"。

**工作量**：小-中。检测器独立可测，注入路径复用现有 system-reminder 机制。

### P2-3 checkpoint 优先、有损压缩兜底（长期项，契合"不丢上下文"）

**MiMo 效果**：溢出时决策树是 **rebuild 优先、compaction 最后手段**——后台 checkpoint-writer 子代理增量写结构化 checkpoint.md（11 节模板、写时按节预算、超预算 spill 到 `checkpoint-<topic>.md` 并留索引行），溢出时在水位处插入边界（**不删 DB 行**），历史从边界切片；只有 writer 失败/记忆关闭时才退回 LLM 有损摘要。配套细节：
- **事务性水位**：`last_checkpoint_message_id` 只在 writer 成功时推进，失败代价是"检查点更旧"而非"丢失"；
- **"下一阈值即重试"**：恢复门是 token 位置而非重试计数，对话停止增长则重试自然停止；
- **重建时保留逐字近期用户消息**（16K 预算，头 60%/尾 30% 截断 + 标注 messageID 和精确恢复路径），工具结果按可再生性分类清除；
- 截断永远保留文档骨架（标题 + 指令 + spill 索引行），截断件仍可导航。

**FreeCodeZ 落点**：现有 compact 是 LLM 摘要（有损）+ microcompact（工具结果清除）。与"**不丢上下文**"原则对照，MiMo 这套是更彻底的解法，但改动面大（writer 子代理、水位、模板、validator）。建议分两步：
1. 近期可做：compact 边界处**保留逐字近期用户消息 + 截断恢复指针**（FreeCodeZ 已有消息持久化，只差边界渲染策略）；
2. 远期评估：结构化 checkpoint 文件 + 增量 writer。注意 FreeCodeZ 的 memoryEnabled 抽取 agent 已覆盖"知识沉淀"一半效果，需先明确 checkpoint 与 memory 的分工（MiMo：checkpoint=会话状态，MEMORY.md=项目知识）。

**工作量**：第 1 步中，第 2 步大。

### P3-1 distill：从轨迹挖掘可复用工作流（契合办公模式）

**MiMo 效果**：/distill（30 天窗口）把原始 SQLite 轨迹当事实源：`GROUP BY tool, substr(input,1,200) ORDER BY count DESC LIMIT 50` 的**频次 SQL 就是模式挖掘算法**，配合用户话术标记（"again"/"每次"/"照旧"）；置信门 = **≥2 次出现或明显将复发且重复成本高**；先盘点既有资产（默认**扩展而非新建**）；**"零产出也算成功**"防止为造而造。产出落 `.mimocode/skills|agent|command/`。另有成熟度门（项目首个会话须早于间隔才首跑）与 10s 去抖。

**FreeCodeZ 落点**：memory 抽取 agent ≈ /dream（已有）；distill 无对应物。办公模式用户反复做同类文档/PPT 工作流，是 distill 的最佳场景。可做成手动 skill/command（先不做自动调度），输入=sessionStore 轨迹查询。**注意**：FreeCodeZ 轨迹在 sessionStore 而非 SQLite，频次启发式需按现有存储改写。

**工作量**：中（一个新 skill + 一个只读查询 helper）。

### P3-2 goal judge 补两个小档位

FreeCodeZ 已有 reason-as-fuel 与 fail-open，缺 MiMo 的：① **`impossible` 档**（判官可判定目标客观不可达，避免无限追赶；prompt 明示"模型自称做不到只是证据不是证明"）；② **硬重入上限**（MiMo 为 12，超限清目标放行停止并 warn——判官永远困不住用户）。均为 prompt + 计数器级改动。

### P3-3 max-mode 的 propose-only 技巧（记录备用）

把每个工具的 `execute` 闭包剥掉，工具集就变成"只提案不执行"——best-of-N 扇出零重复副作用，胜者重放才真正执行；计费上**只有胜者用量进上下文估算字段**（避免 N 倍虚胖触发提前压缩），败者+判官开销单列。FreeCodeZ 暂无此需求，但若日后做"多候选规划对比"，这个技巧能省掉整套影子执行沙箱。

---

## 三、不建议照搬的

| 项 | 理由 |
|---|---|
| SQLite FTS5 记忆索引 | FreeCodeZ auto-memory 走文件 + manifest，规模不到需要全文索引的程度；MiMo 的"文件为源、索引可弃"思想倒是与现有设计一致 |
| QuickJS 沙箱全套（种子随机、删 Date） | FreeCodeZ workflow 走子进程 runtime + journal 重放，确定性由另一条路保证，且已有 imported-cache 携带 |
| 任务树（T1/T1.1） | 效果增量小；其真正价值在"子代理强制写 progress.md + 时间戳对账进 checkpoint"，若做 P2-3 第 2 步可一并考虑，单独不值得 |
| 硬熔断/限额终止 | 与既定设计原则"不做熔断"冲突；重复环用注入纠正（P2-2 的做法）替代 |
| 语音输入 | MiMo ASR 为小米自有模型，FreeCodeZ 无对应供给；桌面端要做语音需另选供应商，属独立产品决策，非本次借鉴范围 |

---

## 四、落地映射速查

| 借鉴点 | MiMo 参考位置 | FreeCodeZ 落点 |
|---|---|---|
| 每模型压缩预算 | `session/overflow.ts`（budget/通配/clamp/哨兵） | `compact/policy.ts`（接线 thresholdPercentOverride）+ 设置 UI |
| 内置 workflow 模板 | `workflow/builtin/*.js` | saved-workflows 全局库 + dynamic-workflows skill 示例区 |
| 多 skill 编排提醒 | `session/prompt.ts:1556-1584` | `context/sections/skills.ts` 注入层 |
| skill BM25/中文别名 | `skill/search.ts`、`skill/localized-alias.ts` | 同上 + zh-CN locale 收割 |
| n-gram 重复监视 | `session/max-mode.ts`（createTextNgramMonitor） | turn-loop + system-reminder 注入；goal 循环加同理由连续上限 |
| compact 保留逐字用户消息 | `checkpoint.ts:renderRebuildContext`（16K/头尾截断/恢复指针） | compact 边界渲染策略 |
| distill | `agent/prompt/distill.txt` + `auto-dream.ts` | 新 skill + sessionStore 只读频次查询 |
| goal impossible 档/重入上限 | `session/goal.ts:64-79`、`MAX_GOAL_REACT` | `target-completion-verification` prompt + continuation loop 计数 |
