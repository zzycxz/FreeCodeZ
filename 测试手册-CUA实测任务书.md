# FreeCodeZ 电脑控制（CUA）实测任务书

你现在是被测对象也是测试执行者：用你自己的 computer-use 电脑控制能力，逐项完成下面 12 个测试，给出可核对的证据。这是对《升级实施手册》桌面控制三 Phase 验收判据的实机复测。

## 开工前必读（防误诊，违反则整份报告作废）

1. 环境事实：computer-use 插件已启用；设置里 cuaControlEnabled / cuaActionsEnabled / Appshot 双击⌘⌘ 均已开。
2. **已知唯一堵点是 macOS TCC 授权**，不是别的。上一轮实测已确认：系统 TCC 库里 `app.freecodez.app` 的辅助功能=拒绝(0)、屏幕录制=无条目。典型症状是：list_applications 有 100+ 进程（走 lsappinfo 不需授权），但 list_windows 全返 `[]`、windowCount 全 0、capture 只得占位窗 `[0,0,0,0]`。
3. **禁止归因**：不许把空结果/失败说成"broker 签名被拒""缺 Helper""只能去 ZCode 端跑"——这已被两轮调查证伪（macOS 是 koffi 进程内路线，不需要 Helper，也没有签名产线）。任何空结果的判别法只有一个：查 TCC（第 0 步）。
4. 工具纪律：被测项必须用 computer-use 工具本身完成；`osascript`/`lsappinfo`/`screencapture` 命令只能做交叉对照并注明"对照组"，不得顶替被测工具。
5. 区分"已验证"（有工具返回/日志/截图证据）与"推断"。每个测试项都要贴**工具原始返回的关键字段**，不要只写结论。
6. 不要安装/卸载任何插件，不要改动与测试无关的设置。T11 之外不许动设置开关，测完恢复原状。

## 第 0 步：权限预检（先做，决定后面哪些能跑）

1. 只读查询 TCC：

```bash
sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
  "SELECT service, client, auth_value FROM access WHERE client LIKE '%freecodez%'"
```

2. 判读：
   - 期望（能全跑）：`kTCCServiceAccessibility` 的 auth_value=**2**，且 `kTCCServiceScreenCapture` 有条目且=**2**。
   - 若不是（比如 0 / 无条目）：**停下来**，明确告诉我："请在 系统设置 → 隐私与安全性 → 辅助功能 / 屏幕录制 里给 FreeCodeZ 开权限"，然后只跑不需要权限的项目（T1、T6 的配置面、T12），其余全部标"受阻待授权"，不要硬跑、不要换备胎工具凑数。
3. 顺手记录（对照组，不算验收）：`lsappinfo list` 里 GUI 应用数 vs 你的 list_applications 进程数。

## 测试项（按序执行）

### T1 观测-进程层（不需 TCC）
- 调 `list_applications`。
- 通过判据：返回 ≥100 个进程，每条含 name / bundleId / windowCount 等字段。
- 证据：进程总数 + 3 条样例原样 JSON。

### T2 观测-窗口层（需辅助功能）
- 对这 5 个应用分别调 `list_windows({app_ref})`：FreeCodeZ、访达(Finder)、Safari、终端(Terminal)、Visual Studio Code。
- 通过判据：至少 4 个应用返回 ≥1 个窗口，且 title 非空、windowCount>0。
- 失败特征：全 `[]` / title 全空 → 回第 0 步查 TCC，不许归因签名/Helper。
- 证据：每个应用的窗口数 + 第一个窗口的 title 原样。

### T3 控件树 + 截图（需辅助功能+屏幕录制）
- 对 TextEdit 调 `get_app_state` / `capture_app`。
- 通过判据：返回含 elements[]（带 bounds）、含截图 PNG（或明确报告"截屏被拒、降级返回 AX 树"——这是设计内降级，要报出来是哪种）；surface_kind 字段存在。
- 证据：元素总数、2 个元素的 bounds 样例、截图有无、surface_kind 值。

### T4 App 操作指南注入（手册 1e 验收）
- 聚焦 Visual Studio Code，对它调 `capture_app` / `get_app_state`。
- 通过判据：返回的 content/advisory 文本块中含 VS Code 专项操作指南（教"这个 App 的特殊交互方式"的段落）。
- 对照再测 Finder 一次（应命中 Finder 指南）。
- 证据：指南文本前 3 行原样（注明来自哪个 App 的指南）。

### T5 多表面捕获（手册 1f 验收）
- 打开 TextEdit 新文档 → 用 `press_key` 按 ⌘S 打开保存对话框 → 再 `capture_app`。
- 通过判据：返回中出现 surface_kind=**save_panel** 的元素（含"保存/存储"按钮的 bounds 与 actions）。
- 收尾：按 Esc 关掉对话框，**不要真保存文件**。
- 证据：surface_kind 值 + 保存按钮的 role/action。

### T6 动作链（需辅助功能；操作确认弹窗我来点允许）
- 打开 TextEdit 新文档 → `left_click` 文档区 → `type_text` 输入 ASCII 串：`hello_fc_cua_9ch`（type_text 只支持 ASCII，**不要输中文**，中文要走 set_value）。
- 再 `get_app_state` 读回文本框的值。
- 通过判据：读回值 == 输入串。
- **人工观察点**：每个动作前说一句"现在看屏幕"——我需要人工确认 HUD 横幅（应显示"FreeCodeZ 正在使用你的电脑…"）和光标动画。
- 证据：读回的文本值 + 动作返回码。

### T7 全链路场景（手册 Phase 1 验收 #1 变体）
- 任务："打开 Safari，在搜索框输入 weather 并回车"。
- 通过判据：Safari 真的出现搜索结果页——用 `get_app_state` 读回验证（URL/页面标题），不许只报"我执行了"。
- 证据：读回的窗口标题或页面证据。

### T8 Esc 取消（需人工配合）
- 发起一个连续动作（例如连续点击 3 个按钮），中途提示我按 Esc。
- 通过判据：Esc 后动作立即停止、任务取消、无卡死、无残留弹窗。
- 证据：停止时的返回/状态 + 之后任务列表状态。

### T9 用户干预（需人工配合）
- 动作进行中提示我动一下真实鼠标。
- 通过判据：光标/动作暂停（应返回结构化 `user_active` 可重试态或明确暂停），不熔断不崩溃。
- 证据：暂停时的结构化返回原文 + 恢复方式。

### T10 Appshot 一键喂屏（需人工配合 + 屏幕录制）
- 提示我**双击 ⌘ 键**（设置里配的是 ⌘⌘）。
- 通过判据：前台窗口截图作为附件自动进入当前会话（你会收到图片附件）+ 有音效 + 路由目标=当前会话。
- 失败时：报告现象（有没有音效、有没有附件），并用 T3 的 capture 链路交叉验证是不是屏幕录制问题。
- 证据：附件是否收到 + 截图内容一句话描述。

### T11 门控对照（设置生效性）
- 把设置 → 电脑控制 → **允许操作（点击/输入）** 关掉 → **新开一个任务/会话**（设置对新会话生效）→ 在新会话里试一次 `left_click`。
- 通过判据：动作被**结构化拒绝**（提示需开启允许操作/权限门关闭），不是静默失败、不是照常执行。
- 测完把开关恢复为开。
- 证据：拒绝返回原文。

### T12 回归项（不需 CUA）
- 问一句普通问题确认模型链路正常。
- 通过判据：正常回答。

## 报告格式（最后一次性给我）

每项一行：

`T编号 | 判定（通过 / 失败 / 受阻待授权） | 证据（原始返回关键字段或日志行，不要转述） | 备注`

失败项必须附：**工具返回的错误原文** + **TCC 查询结果**。日志证据可引 `~/.freecodez/v2/logs/` 当日日志行。最后加一节"人工观察结论"（HUD 横幅有无、光标动画有无、音效有无、Esc 是否即时停）。
