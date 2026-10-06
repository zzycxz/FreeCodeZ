# App 操作指南（Phase 1-e）

`capture_app` 按 `app.bundle_id` 匹配本目录的 `<bundle_id>.md`，命中即把内容作为
`app_instructions` 字段附加到返回（模型在该 App 内操作时自动看到专项提示）。

命名：小写 bundle id，如 `com.apple.Safari.md`、`com.microsoft.VSCode.md`。
内容纪律：只写"这个 App 的特殊交互模式"（AX 树陷阱、键盘流、焦点行为），
不重复通用工具说明；英文书写（模型上下文一致性）；单文件 ≤2KB。

扩展方式：新增 App 就新增文件，无需改代码。实测后再补充——不要凭想象写。
## 2026-10-06 补录：ZCode/ChatGPT 基线 7 个 App 指南（手册 Phase 1e）

来源：ChatGPT.app 内 Package_ComputerUse.bundle/Contents/Resources/AppInstructions 原样
提取（行数与《升级实施手册》v4.1 记载逐一吻合：Notion 47/Slack 14/Clock 53/Numbers 14/
Spotify 13/AppleMusic 21/iPhone Mirroring 10）。命名=各 App 的 bundle id（本机 osascript
`id of app` 实证 4 个：Numbers/Music/Clock/ScreenContinuity；二进制 strings 实证 2 个：
Slack/Spotify；Notion 为手册背书值 notion.id）。lookup 双通道：bundle_id 键优先，
显示名（capture_app 的 AXTitle）兜底。
