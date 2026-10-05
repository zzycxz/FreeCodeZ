# 设计纪要：Word/Excel 升级三约束（跨平台 / 安全 / 结构与长任务）

- 日期：2026-10-01。承接《终版对比》与 Word/Excel 差距分析（活实例控制、修订批注套件、内核 API 化、模板沉淀、自包含运行时五项）。
- 三条约束来自用户：① 跨桌面端平台必须处理；② 安全问题；③ 升级不破坏既有结构，长任务必须准确处理。本纪要把这五项升级逐一对着三条约束过一遍，产出可执行的设计决定。

## 一、跨平台矩阵

### 活实例控制（形态级新能力）

**架构决定：按 AGENTS.md 走 `IPlatformService` 注入，不进 core。** 新增独立接口（建议 `ISpreadsheetLiveControl`）+ 每平台一个实现，作为独立插件交付（能力可裁剪），Renderer 永远只见接口。

| 平台 | 目标 App | 通道 | 备注 |
|---|---|---|---|
| macOS | Excel.app / WPS | AppleScript/JXA（osascript 参数化） | entitlement 已有 NSAppleEvents；TCC"自动化"权限引导复用 CUA broker 模式 |
| Windows | Excel / WPS | COM（attach 运行实例 GetActiveObject，经 PowerShell 桥或原生 addon） | 不新建实例只附着；PowerShell 走 -EncodedCommand 既有链路 |
| Linux | LibreOffice / WPS | UNO API（soffice socket）或 WPS JSA | 无 Excel；UNO 同时服务 headless recalc 复用（见下） |
| 兜底 | 全平台 | 文件级（现有 xlsx 能力） | 实例级不可用时降级为"另存副本→编辑→回写确认"，不熔断 |

**接口面（平台实现的最小公约数）**：`listOpenWorkbooks / getWorkbookIdentity / readRanges / writeRange / formatRange / recalculate / subscribeClose`。pivot/chart/宏不进 v1 接口（各平台支持差异大，等收敛）。

### 其余四项的平台面
- **修订/批注脚本**：纯 Python，天然跨平台；渲染 QA 依赖 LibreOffice（全平台有）；字体回退检测按平台参数化（mac CoreText / win DirectWrite / linux fontconfig），postcheck 规则带平台分支。
- **xlsx 内核 API 化 + soffice 复用**：`-env:UserInstallation` 隔离 profile（照抄 Codex，防污染用户配置）；复用进程由 adapters 层管理。
- **自包含运行时**：按平台键下载（darwin-arm64 / win32-x64 / linux-x86_64-musl…）+ 逐文件 sha256 + musl 检测（/etc/alpine-release）——Codex runtime.json 模式照抄；Windows 编译类工具进 AppContainer 级隔离（P2-5 范畴）。
- **打包**：新原生件（Windows COM 桥）进 electron-builder 配置；AppleScript/UNO 无新原生依赖。

## 二、安全设计

### 活实例控制（新攻击面最大）
1. **能力门**：独立 capability，默认关；首次使用弹授权（复用 CUA broker 的权限引导与 per-app 粒度——Excel 允许/WPS 拒绝可分别设置）。
2. **读写分级并入现有权限体系**：`readRanges` 在 plan 模式默认放行（对齐 bash readonly 哲学）；`writeRange/formatRange` 走现有 permission 规则；**宏执行（VB macro / Office.js / JSA）是红线**：默认禁用 + 显式确认档 + 永不自动启用宏（宏=任意代码执行）。
3. **注入防护**：AppleScript/PowerShell 一律参数化调用（JXA + JSON stdin；-EncodedCommand），文件名/范围引用不拼字符串——对应 bash 转义纪律的既有经验。
4. **乐观并发（防"操作错表"）**：每次操作前校验 workbook identity（路径+脏标记哈希+活动 sheet）；不匹配即报"工作簿已变化"，绝不静默落到别的表——照抄 Codex expectedHeadRevision 语义 + 它的 fail-closed 三元组匹配。
5. **断连 fail-closed**：App 退出/工作簿关闭→句柄失效→报错重连，不猜。

### 其余各项
- **修订/批注脚本**：副本上操作（原件只读默认既有原则）；写回前 schema 校验 + `.bak` 回滚备份；`privacy_scrub` 类脚本输出不落遥测。
- **soffice 复用进程**：受管进程（由 CLI/adapters spawn，非 shell 常驻）；挂会话生命周期（unload delay 后退出）；超时 kill；输出字节上限——不违反"无常驻 shell"（受管进程与 scheduler 同类）。
- **模板蒸馏**：用户文档可能含敏感内容——蒸馏产物只落本地 skills 根（0600），绝不进市场上传通道（纯本地红线）。
- **env 白名单**（P1-3）与 MCP 治理同期落地，活实例插件的 env 面从第一天就白名单化。

## 三、结构兼容 + 长任务准确性

### 结构兼容（不破坏既有架构）
1. **协议**：新增能力全部走新方法/新 capability，不改既有方法语义；zcode-protocol/index.ts 严格类型+运行时校验；采用"骨架键树+null 槽位"扩展协议（旧端安全忽略新字段）。
2. **所有权**：活控制会话状态归 CLI runtime（Renderer 只投影）；跨 Host 路由与 owner/lease 判断保持；Main 只做进程/权限代理不载业务态。
3. **xlsx.py 向后兼容**：旧命令不删不改语义，新增 `--json` 结构化输出模式；soffice 复用做成 adapters 服务，SKILL.md 增路由不动既有三角色流水线。
4. **修订套件**：以新增脚本进入 scripts/，postcheck/visual-judge 既有验收门不动；大文档用 lxml iterparse 流式处理，不整树加载。
5. **spec 先行**（AGENTS.md 纪律）：动工前新建三个 spec——`office-live-control`（含平台矩阵/权限门/幂等契约）、`docx-review-toolkit`（修订批注脚本清单与验收）、`xlsx-engine-api`（soffice 复用与结构化输出）；mcp spec 红线修订另行。

### 长任务准确性（用户特别点名的）
1. **活工作簿会话跨长时**：
   - 操作幂等：命令带幂等键（照抄 execute_document_command 设计），重试安全。
   - **与上下文压缩解耦**：控制句柄不进压缩摘要；压缩/恢复后经 `listOpenWorkbooks` 重新枚举重建句柄（Codex 正是此设计，实测可靠）。
   - 长控任务登记进 scheduler 的 single-flight + 失败退避框架（既有基建），断线重连不丢操作。
2. **soffice 复用进程的崩溃恢复**：崩溃自动重启 + recalc 后错误计数比对（上次结果 diff），异常即报不静默吞；退出走 appShutdownPolicy 进程树清理（既有），不留孤儿。
3. **goal/queue 集成**：跨重启的活控任务由 goal 待续位 + queue revision 水位兜底（路线图 P1-4/P2-1 同期项），保证"过夜任务唤醒后从正确水位续跑"。
4. **验收双保险**：
   - `packages/formal-proof` 状态空间枚举器扩状态集：{打开/关闭/崩溃/权限拒绝/压缩恢复/平台切换} × {读/写/幂等重试/乐观并发失败}，全组合枚举验证不丢操作、不误写。
   - E2E：mac 真Excel + win 真Excel + LibreOffice 三平台冒烟（各一条读写幂等链），进 dogfood 例行。
   - 长任务回归：≥30 分钟活控会话 + 中途两次压缩 + 一次断连重连，操作零丢失为准出条件。

## 四、落地顺序（含三约束的工时影响）

1. docx 修订/批注套件（无新攻击面、纯跨平台、结构零侵入）→ 最先动，同时写 spec。
2. xlsx 内核 API 化 + soffice 复用（中安全面：进程管理；中结构面：adapters 新服务）。
3. 活实例控制（三约束全命中：平台矩阵+能力门+长任务契约最重）→ spec 评审通过后动，v1 只做三平台最小接口（无宏）。
4. 模板沉淀闭环、自包含运行时（独立，可并行）。

一句话：**三条约束里"长任务准确"是硬验收（formal-proof 扩状态 + 30 分钟活控回归），"安全"靠并入现有权限/broker 体系而非新造，"跨平台"靠 IPlatformService 插件化把差异关进每平台实现里。**
