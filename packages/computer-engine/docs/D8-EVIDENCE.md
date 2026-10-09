# D8 砍件取证（W-31 执行时一次完成，规格书 D8 裁定）

取证口径（D8 原文）：本地会话日志与测试用例 grep 无调用记录即砍。

## hold_key（key hold ≤30s）

- 仓库调用面 grep（packages/apps 全量，排除文档/规格/新 SDK 自身）：4 处命中均为
  **UI 渲染器对历史工具名的展示兼容**（cuaActionDetail/cua.tsx 渲染旧会话 toolCallRows
  的 hold_key 字段名——历史渲染保留项，非调用面）；调用面 **0 处**。
- 旧栈 36 例金样场景清单（测试计划-CUA-金样场景清单.md）无 hold_key 场景（#28 cancel_input_holds
  已按 D8 记替补为 kill switch cancel 通道）。
- **裁定：砍**。新 SDK `key` 方法无 hold 参数（W-14 落地即按 D8 缺省）；SKILL 文案已按
  "单键 key、和弦 hotkey"教学，无 hold 残留。

## paste md/html 档

- 仓库调用面 grep：1 处命中为 bash-command-registry 常量名巧合（BASE64 相关），
  非 paste 调用；剪贴板校验件系引擎内部 text 档实现。调用面 **0 处**。
- 金样场景清单无 paste format 场景。
- **裁定：砍**。新 SDK `paste` 仅 text 档（W-14 G.1 映射即按 D8 落地）；SKILL 文案
  "For pasting long text use paste (text only)"。

## 上游 PR 候选（不阻塞，随 orca rebase 时提）

- element_focus 语义化（AXRequestedFocusConfirmation）——SDK 现组合实现（click 聚焦路径）。
- read_element / element_at_point 语义化（AXHitTest + 元素 frame 模型面）——SDK 现桥层
  快照内查找近似。
- Windows 多窗口枚举（runtime.ps1 Get-OrcaWindowList 恒单窗）。
- Windows setValue 回读验证。
