# 实测报告：FreeCodeZ 场景化测试与缺陷清单（2026-10-03）

> 方法转向：不再对照 ChatGPT 列差距，而是**直接跑 FreeCodeZ**（CLI headless 实测 + 脚本化缺陷狩猎），用自己的场景找自己的缺陷。全部结论可复现。
> 环境：仓库内 tsx 直跑 CLI（zcode 0.0.0），宿主 ZCode 环境（真实用户环境）。

## 一、场景实测结果（S0-S4）

| 场景 | 结果 | 证据 |
|---|---|---|
| S0 命令面发现 | ✅ 面**比总账记录的更全**：`doctor`（运行时/打包自检）**已存在**；`--target`（goal 的 CLI 入口）、`--mode`（build/edit/plan/yolo，headless 默认 yolo）、`--resume/--continue`、`--disallowed-tools`、`--memory-bench`、`skills list`（31 个在列）、`plugins list --json`（15 个） | --help 实测 |
| S1 最小回合 | ✅ 端到端通（响应/用量/投影 JSON 齐全，19 个事件）；**但撞出缺陷 D1** | 见下 |
| S2 写命令审批（build 模式） | ✅ 正确拒绝、干净退出、**无 120s 挂死**（文件未创建） | /tmp 验证 |
| S3 巨输出保护 | ✅ 30 万行命令输出 → 总 token 55K（无保护会是 200 万+），上下文未爆 | usage 实测 |
| S4 崩溃恢复 | ✅ **kill -9 后 --continue 恢复，模型准确复述被杀前指令**——消息账本实测不丢（观察+代码+实测三方一致） | sess_df26 实录 |

## 二、实测发现的缺陷（按严重度）

**D1【高】宿主环境泄漏导致 CLI 硬错误（可复现）**
在 ZCode 宿主环境（桌面开的终端、或嵌套 agent 会话——本用户同时跑 ZCode+quartet+FreeCodeZ，必踩）直接运行 `zcode --prompt ...` → `Error: Bundled 与 Active ZCode Built-in Release 均不可用`。需手动清 ZCODE_ENV/ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 等一族变量才能跑。修法：CLI 启动时识别"宿主身份与自身不符"的 ZCODE_* 变量并隔离（namespace 校验），不要让环境决定行为。
**D2【高】英文用户会看到裸键名**：`chat.quota.providerLimited` 只在 zh-CN 存在，且 `IntlProvider.tsx:118` 回退是 `messages[id] ?? id` **无跨语言回退**——英文用户触发配额横幅直接显示键名。修法：en-US 补一条（一行）+考虑回退链改成"当前语言→en→id"。
**D3【中】英文表单单位缺失**：`automations.form.schedule.minuteSuffix` EN 为空串（ZH="分钟"），英文自动化表单分钟选择器无单位（AutomationEditView.tsx:2449 有消费者）。
**D4【中】overseasPayment 整族 65 键 EN==ZH（未翻译或拆除残留）**：中文用户在海外支付相关流程看英文；若支付链已按 P2/P4 拆除，则是该清理未清理的死界面键。
**D5【中·成本】最小回合固定开销实测 27,456 input tokens**（记录口径"43 工具 18.5K"只是工具面；实含 system/技能列表 31 个/上下文节）。占 200K 窗 13.7%，每回合固定吃掉。方向：headless/轻场景的 sections 裁剪（技能列表按 cwd 相关性、系统节瘦身档）。
**D6【低】死键负担**：抽样 26.7% 疑似死键，确认死族：conversationShare.phase.*（10）、feedback.progress.*（约9）、feedback.submit.bug.helper.1-4、5 个单键、settings.memory.viewer.disabled（EN-only+死键双重）。

**正面清单（实测确认做对的）**：审批无人值守不挂死、巨输出截断保护、崩溃恢复零丢失、doctor/skills/plugins/goal CLI 面、双语键 5829=5829 且占位符零冲突、17 设置分区与 18 命令键零缺失。

## 三、总账修正（本轮触发）
- 差距 #16"doctor 命令无"→ **撤销**：`zcode doctor` 已有（轻量：版本/进程/node/平台/打包），残余差距=检查项广度（磁盘/权限/网络可达/安装一致性），降为增强项。
- P2-1 goal 备注补：`--target/--target-replace` CLI 入口已存在。
- MCP 四能力缺口（resources/prompts/elicitation/sampling）维持——本轮未重测但上轮 grep 实证。

## 四、Codex 不是金标准：批判清单（证据在手）
1. **过度建设**：其本机 goals/queue/memories/automations/inbox/visualization 七子系统**全部空转（0 行）**——预建没人用的功能面；FC"真实需求驱动"更健康。
2. **审批摩擦**：四级确认+Guardian 双模型（每次审查多烧 3.6KB 提示词+延迟）；FC 静态只读判定实测零摩擦且 S2 证明该拦的拦得住。
3. **i18n 双标**：自己 zh-CN 漏翻整组键（confirmBeforeClose 7 键，用户截图实锤）、PR Web UI 纯英文；FC 双语对称性 5829=5829+占位符零冲突（仅 D2-D4 三处小缺陷，均可一行修）。
4. **依赖合规单层**：1408 节全 npm，Rust/Python/Chromium/Granola 引擎零披露——多层应用单层 NOTICE。
5. **Chromium 定制维护负担**：自维护 Electron 内核 fork（版本映射都失真：pkg 写 42.3=Chromium 148，实际 154）——永久跟随成本。
6. **schema 债务**：state_5 库 58 次迁移、threads 40+ 列；FC 冻结 schema+幂等加列策略更稳。
7. **发布质量信号**：单日 5 alpha、release notes 全空（"Release 0.161.0-alpha.X"一行）；FC 四门禁绿+pre-push。
8. **体量取舍**：1.5GB 自包含运行时（LibreOffice 414M+Python 361M）对磁盘/更新不友好；FC 宿主引导安装轻得多（代价可复现性——两难，FC 用按需运行时通道补即可）。
9. **反向打脸案例**：codex 把 .git 设只读，实测是错（git 必败场景）；FC 真机校准选择 .git 可写——**抄作业不如做实验**。
10. **提示词冗余**：二进制内嵌全量人格+模型目录再带一份（双份维护面）。

## 五、后续测试建议（未覆盖面）
- UI 层场景（桌面端 E2E：composer/diff/设置页）——需起桌面应用，另一轮。
- 四宿主互通场景（CLI↔桌面↔bots↔远控同会话）——协议级一致性。
- Windows/Linux 真机（沙箱 UI 锁定项+平台分支）——已有遗留清单 #1。
