# FreeCodeZ 项目全记录：从 ZCode fork 到当前状态

> 日期：2026-10-03。覆盖 2026-09 下旬至今的全部工程阶段，基于 40 笔提交的完整 git 历史与各阶段规格书整理。
> 定位背景（三树裁决）：**ZCode = 基线树**（官方 3.14.3 对照源）/ **FreeCodeZ = 试验树**（本仓库：品牌独立 + 能力试验，验证后向产品树输送）/ **quartet = 产品树**。
> 上游：ZCode 3.14.3（Electron + Node/TS monorepo：desktop/services/ui/shared/rpc/provider/server/web + apps/zcode-cli 七包）。

---

##〇 全程总览

| 阶段 | 主题 | 提交区间 | 状态 |
|---|---|---|---|
| 一 | 品牌独立与商业链剥离（P1-P4） | c56e441 → 6d0debe/c266be1 | ✅ 完成 |
| 二 | 去套餐能力补位（P6：搜索/视觉/多厂商） | b914876、7d60169、4f8ed75、031ffd9、3e63515（5 笔） | ✅ 完成 |
| 三 | 官方 MCP 拆除收尾（P7）+ README/发布准备 | 973d4a3、22399c7、24c076c、7a6dc93、816d816 | ✅ 完成 |
| 四 | 上游修复移植（批次 0/1/2-1/2-2/2-3 五批） | 77e22cd → bb6c618（3 笔提交） | ✅ 完成 |
| 五 | bots 双渠道 + 手机/网页远控 + CUA 强化全量入库 | 12cc123 | ✅ 完成 |
| 六 | MCP 可用性优先成本管理（观测层） | 27029fc | ✅ 完成 |
| 七 | 能力提升六批（A/B/C/D/E 沙箱/门禁） | e9d385d → 5cd6fb2 | ✅ 完成 |
| — | MoMA 等模型接入链实证修订 | 2489832（穿插） | ✅ 完成 |

**终态门禁**：typecheck=0 错 / lint=0 错（43 个存量巨型文件经证据豁免，规则对新文件继续生效）/ 测试 9 包 68 文件全绿 / architecture:check 0 违规 / husky pre-push 全链挂接。

---

## 一、品牌独立与商业链剥离（P1-P4，规格书 P1-P4 系列）

**P1 改名（7 笔）**：appId/productName/运行时名/元数据与残留 bundle id → 数据目录 `~/.zcode`→`~/.freecodez`（194+11 处、113 文件）→ 深链与 scheme `zcode://`→`freecodez://`（含 finder workflow、Linux desktop entry）→ 右键菜单/NSIS/进程前缀/cron+server 服务名/浏览器 partition → 更新链静默 → i18n 词级清扫与 README 头。

**P2 去登录与纯 APIKey 接入（8 笔）**：删除官方套餐网关（URL 劫持到 zcode.z.ai ultra 的重写层）；整体删除 oauth/account-provider/套餐订阅/会话分享/官方 MCP/闲时任务（off-peak）服务族与远端内置目录链（UI 侧以"惰性空壳"策略保类型零错）；usage-stats 只留本地层；访问 schema 塌缩为 api-key 单态（zod+config+resolver+CLI+UI 全链，7 组 grep 断言归零）；身份面改名（UA/trace 头/X-FreeCodeZ-Agent/cookie）；lite server 加固（token 守卫+随机端口）；CLI login 中和。

**P3 去遥测与更新链（2 笔+静态收口）**：崩溃上报本地化；autoUpdater/forceUpdate/manifestUpdateProvider/electron-updater 依赖整链删除；ARMS（文件+依赖+patch+init）与 otel 从 desktop 摘除；messageTelemetry 21 个 no-op 化；后续静态收口物理移除 CLI telemetry 包/TTel/actionTrace/appTelemetryRuntime/ZCODE_TELEMETRY env 族，THIRD-PARTY-NOTICES 重生成（1098 版本、8 个过期覆盖清除）。

**P4 外联终验与发布（1 笔）**：市场本地化（内置快照+CDN 资产剥离）、文档/changelog/端点本地化、反馈与社区配置清空、Rive 人设资产本地化、NOTICE 附 fork 声明；产物 146MB 级打包链跑通。

**此阶段的既定取舍（非缺陷）**：无账号体系→无云同步/多设备无缝续接/团队协作；官方市场冻结快照→无用户侧反馈闭环；hexin/同花顺等登录型 MCP 移除鉴权链后不可用（设计使然）；off-peak 闲时任务整链摘除（保留本地 cron）。

---

## 二、去套餐能力补位（P6：搜索/视觉/多厂商，5 笔，间夹 P7 与 README/发布准备批）

- **ImageSearch** 三源降级链（SerpAPI→Brave→Openverse）+ SQLite 缓存 + URL 归一去重 + 限流指引；
- **WebSearch** 原生优先 + Brave/Exa/Linkup 客户端回退（Linkup 端点契约实证修正 api.linkup.ai→api.linkup.so）+ AnySearch 零 key 垫底链；
- **WebFetch** format 参数 + 正文抽取；**ImageUnderstand/ViewImage**（VLM 绑定 + 无视觉模型时引导错误）；
- 设置页"搜索与视觉"卡片（摘要模式/安全搜索/地区码/视觉模型，密钥加密存储）；
- 视觉链三处实证修复：裸 picker 串缺推理档位被静默吞、向导 defaultModelSelection 从未生效、图片引用提示判定对象错位（各带单测锁定）；
- 11 个厂商图标 + provider 接入向导 + 侧栏 Provider/Key 状态指示器 + 推理档位预设（MoMA 实证修订：解析报错自带词表、降级目标取交集最强档、baseUrl 前缀修正——测试 30/30）。

---

## 三、官方 MCP 拆除收尾与告警补全（P7，1 笔）

agent 侧官方鉴权三件套删除、zcode_official 解析改显式不支持；contracts 官方类型族移除；UI 横幅链（配额耗尽/套餐要求）删除；官方 3 个失败 kind 摘除；image-search 从官方插件预置摘除；补 composer 图片引用提示 chip 与 image_input_unsupported 结构化错误码；9 组 grep 断言归零。

---

## 四、上游修复移植（批次 0/1/2-1/2-2/2-3 五批、3 笔提交，对照官方 3.14.3 逐函数对齐）

- **批次 0/1/2-1**：428 skill 门控三件套（zcode-guide 单文件 SKILL、hasLoadedSkill 会话位、四工具 resolveInput 门控+指针描述 **62,784→3,415 字符**）；UI 五修（runId 守卫防自跟随/卡片防挤出/收纳分轮/草稿持久化空快照保结构/链路身份九处派生）；retune 全链（engine 接缝/journal 双实现/投影 limit/工具+GUI 双路由）。测试 16 新增。
- **批次 2-2**：在飞 ask 携带复用（R4=带前代转写前缀的全新执行）——携带资格四条件、种子取在飞边界、四道门、崩溃恢复重建。测试 7 新增。
- **批次 2-3**：workflowRuns 增量 op-log 协议（updated/removed 两 op 替代整键重发 O(N²)→O(N)）——diff/merge/apply/屏障/wire-bounds 全套纯函数 + 水位准入门 + unlisted 计数 + 体积护栏。测试 7 新增。

---

## 五、bots 双渠道 + 手机/网页远控 + CUA 强化（12cc123 全量入库）

- **bots 双渠道**：Telegram/飞书 channel 适配、bindCodes 配对、inbound/reply 管线、taskBridge（建任务强制 yolo + modeLocked §6.9）、BotsService 全链；
- **手机/网页远控全链**：windowRemoteConnectionRegistry、Remote Environment（SSH）、device/client-scenes、内嵌 LAN relay + 本地 dist-mobile（web-remote-replayable 恢复链路与 desktop-continuous 实时链路明确分置）；
- **CUA broker 强化**：PermissionCapabilityGroup.OfficialCua 防伪校验、Windows CUA 打包运行时 manifest 完整性校验（fail-closed）；
- 全仓 CRLF→LF 行尾归一。

---

## 六、MCP 可用性优先成本管理（观测层，27029fc）

设计红线 R1-R4（默认全量注入/观测先于控制/不截断 schema/不可见必须可归因）。落地四件：工具级 **denylist**（唯一写路径=工具清单弹窗，含 A3 修复表单编辑抹除 bug）、服务端 `_meta.ui.visibility` 声明尊重、**tools/list 目录缓存**（进程内 LRU16/30min+连接指纹+`tools/list_changed` 订阅代际防竞态）、**token 观测**（统一口径估算+协议 mcpToolSummarySchema+N/M 双计数+~T tk 徽章）；断连摘除幻影工具（C2，EXIT_AFTER_MS fixture 真集成）。

---

## 七、能力提升六批（本阶段主体，e9d385d→5cd6fb2）

依据：《规格书-能力提升-Codex对标实证适配版 v5》（五轮排查、对标三道闸）→《全部工作-总实施版》。拍板：灾难地板 1B + cron 显式 mode 2A + 沙箱立项 3。

### B 批：Token 卫生（零信息损失）
估算器统一 `token-estimate`（**CJK×3÷4** 单函数五消费方：英文 -24.9% 修提前压缩、中文不低于旧口径防溢出）；Bash 输出无色化（NO_COLOR/TERM=dumb/PAGER 族+强制开色清除+逃生口+Windows 大小写兼容）；截断改 head-tail 对称+omittedBytes+UTF-8 边界裁断；子代理回传预算 120K→16K（env 可调回）。**E3 复测入档：43 工具 73,839 字符 → 新口径 18,493 token**。

### C 批：可靠性
Edit 新增 `line_normalized` 级（27 码点归一）+ 修复 replaceAll 连尾随空白都 miss 的 bug 级缺口（探针复现→表驱动锁定）；CommandInbox 17 个准入语义用例；headless 失败退出码（`--no-fail-on-error` 退回）；gh 限流 ScheduleWakeup 幽灵名悬空指引修正+守卫测试。

### D1：灾难形态地板（yolo 底线）
四类封闭清单（mkfs 族/dd 裸设备排除 /dev/null/rm -rf 裸指根与家目录/关机族），**拦形态不拦命令名**（rm -rf node_modules、chmod +x、curl|sh 官方安装全放行；测试钉死 16 个近邻合法样本零误杀 + 15 个灾难命中用例——注：提交 ce19dd8 信息中的"31 个样本"为笔误，以测试文件实际用例数为准）；解析不安全不拦（保守方向）；build/edit 模式不受影响。

### A1+D2+E-S3：无人值守安全模型全链
- **A1**：自动化会话审批超时缺省 120s（协议 create/resume 双路+兼容省略+桌面 host 注入；超时走既有 deny+留痕；交互会话不限时）——根治 cron 缺省 build + 无超时的永久挂死组合；
- **D2**：cron 创建强制显式 mode（门禁+提交边界双拦+两档说明，旧数据回退展示）；
- **E-S3**：沙箱配置链 0004 冻结迁移（sandbox_enabled 列幂等加列，不改冻结的 AUTOMATION_SCHEMA）→ repo/服务/协议 sandboxEnabled → AgentRuntimeConfig → executor → bash handler；桌面链（scheduler 消息/host createTask+resumeTask/adapter/协议投影）；npm/pip 缓存预注入+Windows TMP/TEMP 重定向；resume 链补齐冷恢复不丢沙箱与超时。

### E：沙箱执行体三平台（对照 codex，弃原生方案）
- **macOS seatbelt**：真机逐项实测校准操作集（`sysctl-read` 缺它 node/V8 崩溃、`/dev/null` literal 缺它 git 必败、signal*/mach* 在新 seatbell 非法剔除；.git 可写——不抄 codex 只读反面教训）（+5ms/命令为 E2 实验继承数据，ZCode 树实测，本仓未复测延迟）；
- **Linux bwrap**：ro-bind 全盘+可写根 bind+tmpfs /tmp，只用上古稳定旗标（防 bwrap 整体报错），未安装 fail-open（UI 三态文案明示"需装 bwrap"）；
- **Windows 低完整级 MIC**：PowerShell Add-Type ~40 行 C# 降自身令牌 Low IL（内核禁写全域 Medium IL 文件、全盘读保留），icacls 把 workspace 降标为唯一可写区（幂等、无需恢复清理）；**真机验证前 UI 保持禁用**（win32 集成测试自动激活，验证后一行放开）；
- **S2 归因**：violation 分类器（EPERM 家族+路径提取+npm/pip 缓存重定向指引）；
- **激活语义唯一权威**：`wrapCommandWithSandbox`——必须显式 `mode:"workspace-write"`（`enabled` 是历史遥测位，回归锚钉死防默认全量沙箱化事故）。

### A2：门禁基建
根 `pnpm test`（按包分组 runner，cwd+TSX_TSCONFIG_PATH 自动处理）；verify:pre-push 补 typecheck+test+arch；husky 真实挂接；修 3 个 CUA integrity 存量坏测试（macOS /var 符号链接根因）；43 个存量巨型文件 max-lines 经证据豁免（清单封口）。

---

## 八、当前产品能力现状

> **2026-10-06 补记**：本节快照止于 10-02 门禁基建期。10-05~10-06 升级执行潮新增能力（明细见第十节）：macOS 电脑控制三件套（koffi FFI 执行层+光标 HUD 可视化+Appshot 一键喂屏，设置双开关默认关）、MCP resources+prompts 通道、diff hunk 级拒绝、worktree、PR 双层工具集、更新检查器、doctor 探针、安全堵漏 9 项与 0B/0C 缺陷批；测试面现为 **12 包 113 文件**。

**身份与接入**：纯 APIKey 多厂商（智谱 GLM 全系/MoMA 等模板+11 厂商图标+接入向导），无登录无遥测无更新链；`~/.freecodez` 数据域。
**四宿主形态**：桌面工作台（编程/办公双模式）/ CLI+headless（--output-format、失败退出码）/ 手机远控（LAN relay+replayable 恢复）/ bots 双渠道（Telegram/飞书，强制 yolo+灾难地板）。
**代理与工具**：43 内置工具（固定成本 18.5K token）+ 动态工作流引擎（TS 编译器驱动，428 门控指针化）+ MCP 观测层（denylist/visibility/目录缓存/token 徽章）+ 子代理角色模板（frontmatter）+ 后台任务生命周期 + todo/plan/checkpoint/rewind 全链 + 五诊断技能族。
**安全分层**：六层命令审批流水线（unbash AST+只读语义引擎+Fig 522 注册表+动态 capability）→ 灾难地板（yolo）→ 审批超时（无人值守）→ 沙箱（mac/linux 生效，windows 待验证）。
**质量门禁**：typecheck/lint/test(9 包 68 文件)/architecture 四绿 + pre-push 全链。

**FreeCodeZ 反超/独有**（对比 codex）：手机远控 owner-lease-replay、bots 聊天渠道接入、动态工作流引擎、cron 本地栈、goal 外部完成验证器、diff 行数统计、compact 时间线六态、办公模式、市场快照、纯 APIKey。

---

## 九、已知限制与遗留清单

| # | 项 | 状态 | 条件 |
|---|---|---|---|
| 1 | Windows 沙箱真机验证 | 代码即绪、UI 锁定 | 任意 Windows 机 `pnpm install && pnpm test`，全绿后一行放开 |
| 2 | writableRoots 配置面 | 未做（体验增项） | 沙箱真实使用后按需 |
| 3 | X-Title 仍自报 Z Code（P10 遗留热修） | **已修（2026-10-06 复查轮）** | 8b0bf42 只改了 bootstrap 侧、shared zcode-source-headers.ts 两行漏改——本轮补改并重建 dist；另修退出确认弹窗"Z Code"文案残留 |
| 4 | 安装包未签名 | 待办 | 先 ad-hoc 签名+引导文档 |
| 5 | 桌面全局沙箱开关 / landlock 双保险 | 观察项 | 真实需求驱动（bots 接沙箱已落 0-4：任务建/续双边界强制注入，e0b5089） |
| 6 | 决策点 4（MCP 懒加载）/5（code-mode GLM 复跑） | 4 已过门：A/B 对照通过（flash -5.6pp/pro -2.8pp<10pp，判定数据入 mcp spec §12，目录态管线全通、flag 默认仍关按需开）；5 开放 | 5 等拍板 |

---

## 十、升级实施手册执行潮（2026-10-05~10-06，手册 v4.1→v4.2）

手册 v4.1（cef32fe 入库）发布当日晚间起连续落地约 25 笔提交（e0b5089→f220da0）；手册已于 10-06 出 **v4.2 状态对账版**（全册 ✅/⏸ 落地标注+勘误 13 处+挂账固化）。

- **第 0 批安全堵漏 9 项**（e0b5089）：sed 只读误判三路绕过/沙箱开关 alwaysAsk 审批门/子代理沙箱继承/bots 任务强制沙箱/灾难地板四类绕过（36 拦截样本）/daemon token 守卫/MessagePort dispose/anthropic 版本头/seatbelt 只 deny credentials.json（真机 sandbox-exec 实证，agent 调模型不受影响）。
- **第 0B/0C 批缺陷修复**（dcc2cd9/6ad4c69/3a271d3）：FK 时序双写入者守卫/workflow 挂死主修+amend 同前驱互斥/memory 抽取 cursor 持久化/workflow+memory+供应商链补遗（actor 上限 128/白名单/强标识/SSE 中断重试/V10 docker inspect）/relay 帧协议下沉 shared 镜像归零。
- **第一批**（6629bb7+更新检查器三笔 5ef78af/6aca461/bf7e041+env codemod 三批 1fd161c/c476bfd/fea9d64）：i18n 六子项（死键 193 删+pre-push 校验）/安全教材四级确认政策/doctor 五探针/env 剥离（数据根双读+迁移 warn+define 宏 19 名+字符串键值族；落定口径 330 名/1809 处/366 文件）/更新检查器（GitHub API+自有端点默认源+限流退避）。
- **桌面控制三 Phase**：Phase 1 koffi FFI 执行层（4c6ce85：24 方法三道保险+koffi 三实测坑；1e 七 App 指南 f451498；1f 表面分类+生命周期快照差分 efa284f；设置双开关+光标广播端口 53717 f220da0；真机三波验证 50584a4）→ Phase 2 可视化（5beea93 基础光标 HUD→b8236db 30 参数动画引擎→e5e5c85 scoot 变形/用户干预/Esc）→ Phase 3a Appshot（0b6daf5+305be73+2a0e402）。
- **第二批**：7 diff hunk 拒绝全链（545e8a5+f1a1a81）/8 MCP 治理闭环含 A/B 通过（04d0aca+09835fa+ed4a7f1）/9 resources+prompts 真实 server e2e（d983ae3+9ce0858）/10 worktree（c401f9c+82c1f6e）/11 PR 工具集（79fa3e2）/12 子项 docx 批注四能力+soffice 隔离（a77c904）。
- **第三/四批**：13-19 信号评估收口+请求头清扫（8b0bf42，评估文档 docs/evaluations/）/22 三 UX 全落（被拒计数/关窗五场景覆盖定案/终端 cwd 联动）/24 尸壳审计定案（19cb019：协议契约保留）+FreeCodeZ Protocol 双名兼容+心跳降 debug（f8d2e8c）。
- **复查轮（2026-10-06）**：X-Title shared 侧漏改补改（8b0bf42 提交信息"双处"虚报——只改了 bootstrap 侧）+退出确认弹窗"Z Code"残留补改+adapters 间歇失败根治（4cfcd25）+手册 v4.2 状态对账。

**挂账（等条件触发）**：0B-2 真实 key 前置/0C-3② 千帆带 key 实测/Phase 3b 活控验收（Excel/WPS 真机；Numbers 画布不暴露单元格级 AX 已实测）/Phase 2 干预闭环（重查 AX 后续跑+动作流暂停）与 45 帧透镜/条目 7 e2e 与 Appshot 打包态 TCC 终验/条目 1 残余（类型接口键名联动+契约新键改名）/xlsx recalc 性能/测试债三项（桌面 UI E2E、四宿主互通、Windows+Linux 真机，0C 批后排期）。

**配套工作文档**（工作区，规格书系列按 .gitignore 惯例不入库）：总实施版（执行入口+附录 F 复测数据）、实证适配版 v5（五轮排查与三道闸）、沙箱/确定项两附录、过错复盘、工作总结、Orca 轴差距分析。
