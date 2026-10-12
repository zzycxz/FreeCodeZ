# computer-use

FreeCodeZ 内置电脑控制技能包（FC 自有件，规格书 W-15 分发载体）。

- `skills/computer-use/SKILL.md`：模型可见面——引导语句（`setupComputerUseRuntime()`）、
  `computer.*` API 全表、稀疏索引纪律、错误码剧本。
- 引擎本体在 `packages/computer-engine`（orca 1.4.214 快照派生，见其 NOTICE.md）；
  运行时宿主为 node-repl-host seed 单元（`dist/mcp/server.js`），本包只携带 skill 文档。
- 启停语义：内容型插件 `defaultEnabled: true`（skill 文档常驻模型面）；
  引擎是否可用由桌面设置总开关 `cuaControlEnabled` 经生效链
  （desktop settings → agent env `FREECODEZ_CUA_CONTROL_ENABLED` → bootstrap →
  node_repl env `FREECODEZ_CUA_DISABLED` → computer-bridge fail-closed）决定，见规格书 V1.17。
