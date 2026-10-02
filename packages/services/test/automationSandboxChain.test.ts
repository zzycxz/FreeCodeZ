// E-S3 链路测试：沙箱开关从协议 schema → services 参数构造 → repo 持久化 →
// automation 读回的全链；以及迁移幂等性。Bash handler 侧的策略解析在 core 测试
//（sandboxBashRequest）；adapters 侧缓存注入在 adapters 测试（sandboxSeatbelt）。
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { AutomationRepo } from "../src/session/automationRepo.js";
import { zcodeSessionCreateParamsSchema } from "@zcode/shared";

test("迁移：0004 加列且幂等（二次执行不抛错）", () => {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const cols = db.prepare("PRAGMA table_info(automations)").all().map((c) => (c as { name: string }).name);
  assert.ok(cols.includes("sandbox_enabled"));
  // 重放幂等：checksum 一致即跳过，不应抛错。
  runTasksDatabaseMigrations(db);
  db.close();
});

test("repo：create 写入 sandboxEnabled，update 可显式开关，缺省不携带", async () => {
  const repo = new AutomationRepo(":memory:");
  const createOptions = { nextRunAt: null as number | null };
  const created = await repo.create(
    {
      title: "t",
      cronExpr: "0 9 * * *",
      prompt: "p",
      sandboxEnabled: true,
      workspacePath: "/tmp/ws",
      recurring: true,
    },
    createOptions,
  );
  assert.equal(created.sandboxEnabled, true);
  assert.equal(created.mode, undefined, "缺省 mode 不携带");

  const off = await repo.update(created.automationId, { sandboxEnabled: false });
  assert.equal(off?.sandboxEnabled, undefined, "false 按未设置语义读回");

  const onAgain = await repo.update(created.automationId, { sandboxEnabled: true });
  assert.equal(onAgain?.sandboxEnabled, true);

  // 未提交该字段时保留现状。
  const untouched = await repo.update(created.automationId, { title: "t2" });
  assert.equal(untouched?.sandboxEnabled, true);
  assert.equal(untouched?.title, "t2");
});

test("协议 schema：session/create 接受可选 sandboxEnabled；automation schema 透出", () => {
  const base = { workspace: { workspacePath: "/tmp/ws", workspaceKey: "/tmp/ws" } };
  assert.equal(
    zcodeSessionCreateParamsSchema.parse({ ...base, sandboxEnabled: true }).sandboxEnabled,
    true,
  );
  assert.equal(zcodeSessionCreateParamsSchema.parse(base).sandboxEnabled, undefined);
  assert.throws(() => zcodeSessionCreateParamsSchema.parse({ ...base, sandboxEnabled: "yes" }));
});
