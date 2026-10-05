# App 操作指南（Phase 1-e）

`capture_app` 按 `app.bundle_id` 匹配本目录的 `<bundle_id>.md`，命中即把内容作为
`app_instructions` 字段附加到返回（模型在该 App 内操作时自动看到专项提示）。

命名：小写 bundle id，如 `com.apple.Safari.md`、`com.microsoft.VSCode.md`。
内容纪律：只写"这个 App 的特殊交互模式"（AX 树陷阱、键盘流、焦点行为），
不重复通用工具说明；英文书写（模型上下文一致性）；单文件 ≤2KB。

扩展方式：新增 App 就新增文件，无需改代码。实测后再补充——不要凭想象写。
