# 测试计划：CUA 金样场景清单（W-00③ 产物）

> 依据《规格书-FreeCodeZ-电脑控制引擎接替.md》V1.8 W-00③：W-02 连包删除 `packages/zcode-cua`（含旧金样 fixtures）前，把 36 例官方 wire 实录的**场景清单**固化于此。
> **口径（R4/W-22）**：仅继承场景覆盖面；期望值全部以新引擎（orca sidecar 契约）自有点位重录，**禁止以官方实录作期望值**。
> 来源：`packages/zcode-cua/test/golden/fixtures/official-helper-win32.json`（36 例 = 24 成功 + 12 错误），提取于 2026-10-09。

## 逐例映射表（旧场景 → 新引擎等价场景）

| # | 旧场景 | 新引擎等价 | 处置 |
|---|---|---|---|
| 0 | ping | `handshake`/`capabilities` | 重录 |
| 1 | error/client_api_version_mismatch | 无版本协商（砍） | 替补：mac protocolVersion≠1 → provider_incompatible（重试一次后报错路径） |
| 2 | pre_auth_broker_info_claim_semantics | `capabilities`（无鉴权门，listApps 天然可用） | 重录（身份声明语义砍，见附录 L） |
| 3 | pre_auth_business_call | `listApps` 无门直调 | 重录 |
| 4 | authenticate_ok | 无 authenticate（砍） | 替补：sidecar 首次 fork + 未知 method 路径 |
| 5 | broker_info_claim | 同 #2 | 重录 |
| 6 | controller_status | 会话层租约状态（W-25 自有面） | 新面自录 |
| 7 | request_access_readonly | `permissions`/`permissionsStatus`（mac 经 helper 探测；win 合成"无需授权"） | 重录 |
| 8 | permission_status | `permissionsStatus` | 重录 |
| 9 | input_permission_status | 砍（mac 细分权限查询） | permissionsStatus 覆盖 |
| 10 | screen_capture_status | `screenshotStatus`（每次采集的结果态，非权限查询） | 重录（语义变更登记） |
| 11 | supports_accessibility | `capabilities.supports.*` | 重录 |
| 12 | list_applications | `listApps` | 重录 |
| 13 | list_windows | `listWindows` | 重录（win 单窗限制为已知取舍） |
| 14 | capture_app_tree | `getAppState` + noScreenshot | 重录 |
| 15 | capture_app_screenshot | `getAppState` 含截图（降采样/scale/screenshotStatus.captured） | 重录 |
| 16 | capture_app_hidden_tree | 砍（tree_shown_to_model 无对应，引擎恒全量） | 无替补（登记取舍） |
| 17 | read_element | 桥层快照内查找（W-31） | 新面自录 |
| 18 | error/element_unavailable_bad_token | `element_not_found`（stale index：缓存未命中/签名漂移） | 重录 |
| 19 | element_set_value_ok | `setValue`（含 verified/value_mismatch 回读） | 重录（验证语义为 orca 新增） |
| 20 | error/not_settable | `value_not_settable` | 重录 |
| 21 | error/not_selectable | select_text 部分范围砍（D4） | 替补：全选组合实现场景（click 聚焦+hotkey CmdOrCtrl+A） |
| 22 | element_perform_action_invalid | `performSecondaryAction` 非法动作名 → action_not_supported | 重录 |
| 23 | element_press_ok | `click` elementIndex（AX 语义路径 actionName） | 重录 |
| 24 | element_at_point | 桥层快照查找（W-31） | 新面自录 |
| 25 | error/text_too_long | SDK 层 1024 UTF-16 拆分教学（W-31） | 新面自录 |
| 26 | error/bad_frame_provenance | 帧机制砍（S11） | 替补：坐标越界/参数残缺 → invalid_argument |
| 27 | error/method_not_found | sidecar 未知 method → invalid_argument | 重录 |
| 28 | cancel_input_holds | hold_key 砍（D8） | 替补：kill switch cancel 通道（W-25） |
| 29 | prevent_activation | 焦点克制砍（附录 L.1-4） | 替补：restoreWindow 行为验证（window_not_focused 两态文案） |
| 30 | is_focus_steal_prevented | 同上砍 | 无替补（登记取舍） |
| 31 | reenable_activation | 同上砍 | 无替补（登记取舍） |
| 32 | pip_is_running | PiP 砍（D5） | 无替补 |
| 33 | pip_clear_dismissed | 同上 | 无替补 |
| 34 | error/pip_session_requires_presentation | 同上 | 无替补 |
| 35 | error/pip_session_event_requires_presentation | 同上 | 无替补 |

## 新面须补的非旧覆盖场景（W-22 增补）

旧金样未覆盖、新契约必测：`scroll`（方向×页数）、`drag`（元素对/坐标对）、`typeText`（CJK/AXReplaceSelection verified）、`pressKey`/`hotkey`（key-spec 校验+AXSelectAll 捷径）、`pasteText`（16MiB 上限+剪贴板恢复）、`app_blocked`（密码管理器封锁）、`[redacted]` 脱敏、`truncation`（超 1200 节点）、`screenshotStatus.skipped`（noScreenshot）、`window_stale`（动作后窗口消失）、三平台 `capabilities` 各自的 supports 真值。

## W-00② 哈希基线记录

- `ax_native.node` SHA256 = `92533fe564b8943b69a18b9080da2f7600e00eb2c20e560756b81fbbdc06192e`（官方原始值，二进制未清扫——A2 黑名单 A 首条，已固化）。
- `windows-helper.js` 记账值（SHA256SUMS）为**品牌清扫后值**；官方原始哈希本地不可得（vendoring 源目录在 Windows 机器）。**A2 兜底**：黑名单 A 收录清扫后值 + 黑名单 B 路径形态 + 黑名单 C 内容标记三层比对，清扫变体不会漏网。
