# App Notes（app-instructions）

针对具体应用的界面操作要点，在 `get_app_state` 命中目标应用时随结果注入（W-27）。

**来源披露（A12 双判据②）**：
- `com.apple.Safari` / `com.apple.finder` / `com.microsoft.VSCode` 三件为 FreeCodeZ
  自写（旧栈同名件留迁，工具名已换新 SDK 面）。
- 其余七件（Music / Clock / Numbers / Spotify / Slack / Notion / iPhone Mirroring）
  **全部按 D9 重写**：旧栈中的第三方提取件仅作为"该应用有哪些坑"的需求参考，
  逐件以自有措辞重新撰写，零原文保留；提取件已随 W-01/W-02 删除不入库。
- 本目录不含任何第三方产品的官方操作手册文本。

维护约定：新条目一律自写；只在确认应用行为后添加，不确定的行为写"先 re-observe"
而不是猜测。
