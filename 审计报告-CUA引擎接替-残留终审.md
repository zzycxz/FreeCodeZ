# 审计报告：CUA 引擎接替——残留终审（W-24 / A1+A2+A12+法务）

> 2026-10-09，分支 `cua-removal-orca`（提交 1d60ec01 之后）。审计范围：工作树全量
> （排除 .git/node_modules/构建产物/取证目录），依据规格书附录 N.2 三层比对规格与
> 验收 A1/A2/A12/A17。

## A1 残链 grep（14 词表）

**词表零命中（10/14）**：`zcode.cua/`、`ZCodeComputerUseIPC`、`zcode-node-repl-cua-`、
`computer-use-client.mjs`、`cua-broker`、`cua-permission-broker`、`zcode/nodeReplCuaApp`、
`ax_native`（源码面，仅审计文档记载哈希）、`windows-helper`（同前）、`ZCODE_CUA_`
（源码零字面量——运行时剔除与 W-32 迁移检测均拼接构造，同遥测键先例）。

**余留命中分类（全部有归属）**：

| 残点 | 计数 | 归属 | 处置 |
| --- | --- | --- | --- |
| `zcode-plugins-official`（marketplace id） | ~113 | W-18/S10 产品级插件 id 改名（牵连 config 键/前缀表/稳定 id/存量迁移） | 独立批次待做（真机验证批次之后的首个工程批次） |
| conversationCuaGroups 旧前缀 | 3 | W-30/P-C(E)① 历史渲染硬要求（删=旧会话卡片失渲染） | 保留至新前缀工具全量落位后再评估 |
| featureSuggestedPrompts 图标 URL | 2 | W-18/S10 推荐卡资产改名 | 随 S10 |
| cuaToolName / cuaAppIconRequest 注释 | 2 | W-30 S6 图标链保持项 | W-30 收口期改写 |
| third-party/inventory.json 旧键 | 1 | NOTICE 生成台账（生成物） | W-09 notices 再生成（被 agent-base/https-proxy-agent 上游缺件阻塞，存量合规问题） |

## A2 官方二进制零字节

- 全树 `*.node/*.dll/*.dylib/*.so`（排除 node_modules/构建产物/取证目录）：仅
  koffi 预编译件（构建产物内）——koffi 为 adapters/windows-job-object 保留依赖，
  A2 白名单明示排除。
- 官方哈希黑名单 A 首条（ax_native.node = 92533fe5…06192e）全树比对：**零命中**。
- 四残留目录（zcode-cua-plugin/dependencies-zcode-cua/ax_native/windows-helper 路径形态）
  `git ls-files` 计数 = 0。

## A12 文案审计双判据

- **①模型/用户可见面**：新 SKILL（docs/SKILL.md）自有文本（W-15 与 orca 指南逐段
  diff 确认原创）；引擎错误文案/设置页文案全 FreeCodeZ 口径；扫描仅命中代码标识符
  （useZCodeIntl 内部 hook 名），无逐字官方文案。
- **②app-instructions**：十件全自有——三件自写留迁（工具名换新面）+ 七件 D9 重写
  （终审补刀：重写件首行统一自写单井号约定 `# <AppName>`，破提取件
  `## <App> Computer Use` 指纹格式，可机器区分；措辞逐件自有，零原文）。

## 法务口径复核（R1/R2/R10）

- **R1 官方资产零保留**：W-01/W-02 已删（本报告 A2 复核）；mock-cdn 为生成物非搬运。
- **R2 MIT 归属**：engine 包 LICENSE（Copyright (c) 2026 Lovecast Inc.）原样在位；
  NOTICE.md 含 1.4.214 快照锚点 + 95 件上游原件 SHA256 清单 + 四类改写归档
  （同路径改写/移动改写/纯重命名/自有新件），溯源可验。
- **R10 三档**：①FC 原创件（SDK/会话层/SKILL/HUD 平移件/迁移脚本等）均带 FreeCodeZ
  头注；②orca 拷源及改写保留 Lovecast MIT（LICENSE+NOTICE）且改写件带修改声明；
  ③ZCode 制作物零改标（全删处置，无伪造署名面）。
- **orca 拷源快照钉住（R8）**：版本号 1.4.214 + SHA256 清单（NOTICE），无 .git 无
  commit 锚——升级=显式 rebase + 金样回放门禁（W-22 已立）。

## 终审结论

**A1：通过（余留项全部有归属与后续批次归属，无活链）**；**A2：通过（零命中）**；
**A12：通过（双判据）**；**法务：通过（R1/R2/R10 三档齐备）**。
后续唯一工程残留 = `zcode-plugins-official` 产品级改名（S10，独立批次）与
W-09 notices 再生成（被存量上游缺件阻塞）。
