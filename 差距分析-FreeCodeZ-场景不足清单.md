# 差距分析：FreeCodeZ 场景不足清单（v4 终审 · 宁缺毋滥）

- **排查简史（六轮）**：v1 以 Orca 机制为标尺（误，被用户指正）→ v2 效果标尺复核 → v3 对 v2 自身证伪 → **第四轮设计意图审查**（有 spec 裁决即剔除）→ **第五轮对抗复核**（专杀条目 + 逐条核对引用）→ **第六轮主线终审**（幸存条目逐字符验证）。
- **终审标准**：同时满足①真实用户在具体情形下受损且无替代通路；②非任何 spec/规格书有意裁决的边界；③非增强机会/产品决策；④引用经逐字符核实。四关全过才留。
- 日期：2026-09-29（v4 定稿）

---

## 终审结论：唯一真不足 —— X-Title 品牌残留（P0 热修）

**每一次模型 API 请求都对外自报 `X-Title: Z Code@…`**，且规格已裁决未执行、验收即红、无门禁兜底。第五轮四路对抗（已实现？/效果达成？/理论场景？/范畴？）全部杀不掉，是六轮排查唯一幸存条目。

### 证据（第六轮主线逐字符验证）

| 位置 | 内容 |
|---|---|
| `packages/shared/src/zcode-source-headers.ts:6` | `"X-Title": "Z Code@electron"` |
| `packages/shared/src/zcode-source-headers.ts:50` | `` `X-Title": `Z Code@${sourceTitle}` `` |
| `apps/zcode-cli/packages/bootstrap/src/model-config.ts:59` | `` `Z Code@${sourceTitle}` ``（CLI 路径） |
| 活代码链 | `buildZCodeSourceHeadersFromContext` → `sourceHeaders.ts:65,79` → `nodeApiClient.ts:10` → 每次模型请求携带；CLI 主路径注入 provider 客户端 defaultHeaders，**用户自配的任意 OpenAI 兼容端点都能看到** |
| 打包产物 | desktop 双平台 `zcode.cjs`、server 多 chunk、shared/bootstrap dist 均残留（比 P10 记录的 3 份更多） |
| 规格状态 | P10 规格书 R4-0（§167）已裁决热修"3 处直接换"；验收 R4（§223）"运行时字符串零 'Z Code'"**当前即红**；R6 要求的品牌残留门禁在 `verify:pre-push`（仅 lint+architecture:check）中**不存在** |
| 终审新发现 | 同文件 `"User-Agent": "ZCode/unknown"` / `` `ZCode/${appVersion}` `` 同样随请求外发——热修时应对照 P10 四象限判定一并核处 |

### 修复清单

1. 三处源码 `Z Code@` → `FreeCodeZ@`（P10 R4-0 原裁决）；同函数 User-Agent/X-ZCode-App-Version 按 P10 四象限判定核处。
2. 顺手补品牌残留扫描脚本（grep 构建产物与 src 的 `"Z Code"`/`Z Code@`）挂进 `verify:pre-push`，落实 P10 R6 门禁——否则热修后无防回流。

---

## 被剔除条目及死因（第五/四轮裁决，信息不丢失）

| 原条目 | 死因 | 关键证据 |
|---|---|---|
| 在飞 turn 不自动续跑 | **用户已裁决"不做"**：《规格书-能力提升》§〇"不做：跨重启自动续消费（用户裁决）"、§1.3"有意裁决的 discard+留痕+确认重发"；代码注释（target.ts:421-432）说明自动续跑会复活用户主动停止的任务；turn 级续跑已立项 P4-9 独立规格书承接 | 规格书 :22/:37/:109 |
| Cron 绑桌面 scheduler | 事实真但**非缺陷**：daemon 从未承诺 cron（server-core 零 automation 引用）；桌面常驻缺省开（`webRemoteControlAutoEnabled=true`，undefined 视为开启）缓解；"宿主关了定时任务丢窗口"与系统 crontab 语义平价；Orca 桌面关闭调度同样死 | `validationAppSettings.ts:465`；属接线机会非违约 |
| 远程 workspace 拴桌面连接 | 架构使然，与任何桌面 SSH 客户端同构；Bot `/reconnect` 提供远程重连通路（60s 超时配对） | `botRemoteWorkspaceReconnect.ts` |
| 自动三方合并缺失 | 参照物 Orca 也没有（其 Ship 是人工 Review）；效果可由"模型中介合并 + 用户终端 git merge"达成；前置场景（并行分叉副本）依赖未实现的 worktree 隔离——**屋顶先于墙**；要不要自动化是产品赌注 | `gitCheckpointRepo.ts:375-385`（restore 是冲突检测非合并）；worktree 在自宣告清单 #1 |
| 通知最后一跳（Bot 深链/web 会话路由/PWA/出站附件） | 手机推送效果**已由 Bot 通道达成**（直达系统通知栏）；审批已内联闭环（Telegram callback 按钮直接 approve/deny）；手机页 mobileHome 即任务列表点开即达会话——深链省的是点击数不是通路；PWA 推送超出 spec 对手机页（官方页等价物）的定义 | `replyPipeline.ts:545-560`；spec web-remote-control §6 |
| 外置 relay 无独立发行物 | spec §1.11 明文有意边界（零第三方；自建=源码+反代 TLS），产品决策非缺陷 | spec 第 17 行 |
| http:// origin 保存无安全警示 | 危害需"偏离 spec 指导的 TLS 反代 + 公网裸 http + 路径有嗅探者"三条件同时成立——条件性加固 nicety，一行文案级 | `webRemoteControl/index.ts:231-254` |

---

## 附录：非"不足"的三类清单（防止丢失与重复立项）

**A. 接线机会**（已备好未接线，按需排期）：桌面本地工作区 attach standalone daemon（`/ws/host` 协议在、无调用方）；Cron 轮询移交 daemon；gitCheckpointService 跨 checkpoint 对比/恢复 UI（服务已注册、无消费者）。

**B. 增强 backlog**：Bot 消息带会话深链 + web 工作台会话路由（两端同修）；手机页 PWA/后台通知；Bot 出站附件回传（telegram 仅 sendMessage）；http origin 一行安全警示文案。

**C. 产品决策项**：relay 要不要出 Dockerfile/单发行物；自动三方合并要不要做（依赖 worktree 隔离先落地）；worktree 隔离落地或明确不做（自宣告 #1，无 spec 裁决）。

**D. 灰色地带**（代码自宣告、spec 未裁决，同 v3 §2.6）：权限 auto 模式、Web 模式远程连接、remote 仅 POSIX、飞书附件下载、automation workspace 恒 local、browserControl pageAssets、i18n 孤儿 key 等约 10 项。

---

## 附：六轮方法存档

| 轮次 | 方法 | 教训 |
|---|---|---|
| v1 | 机制对照（Orca 有什么我们没有什么=差距） | 错误标尺：不同产品方法不同效果可等同 |
| v2 | 效果对照（场景→效果→自有机制→达成度） | 仍漏判自有实现（daemon/Bot/fencing/外置 relay） |
| v3 | 对 v2 自身证伪 + 代码自宣告扫描 + 主线裁决子任务矛盾 | 子任务"全仓无 X"结论也需抽查（漏检 zcode-server-cli） |
| 第四轮 | 设计意图审查（spec/规格书/git log 找裁决） | 有裁决即剔除；"跨重启自动续消费"竟是用户裁决不做项 |
| 第五轮 | 对抗复核（已实现？/效果达成？/理论场景？/范畴？四路杀条目+核对引用） | 事实全真的条目也可死于范畴检验（机会≠缺陷） |
| 第六轮 | 主线终审（幸存条目逐字符验证） | 幸存者证据反而更硬（发现 User-Agent 附加残留） |
