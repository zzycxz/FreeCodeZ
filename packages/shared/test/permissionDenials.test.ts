// 第四批 22①：被拒权限计数聚合测试。
import assert from "node:assert/strict";
import test from "node:test";
import { createPermissionDenialCounter, denialDisplayData } from "../src/permission-denials.js";

test("deny 计数：按 task 维度+全量；allow/escalate/modify 不计", () => {
  const counter = createPermissionDenialCounter();
  counter.record("task-a", "deny");
  counter.record("task-a", "deny");
  counter.record("task-a", "allow");
  counter.record("task-b", "deny");
  counter.record("task-c", "escalate");
  counter.record("task-d", "modify");
  assert.equal(counter.byTask.get("task-a"), 2);
  assert.equal(counter.byTask.get("task-b"), 1);
  assert.equal(counter.byTask.has("task-c"), false, "escalate 不计");
  assert.equal(counter.byTask.has("task-d"), false, "modify 不计");
  assert.equal(counter.total, 3);
});

test("displayData：零拒绝不显示；>0 显示计数", () => {
  const counter = createPermissionDenialCounter();
  assert.deepEqual(denialDisplayData(counter, "task-x"), { count: 0, show: false });
  counter.record("task-x", "deny");
  assert.deepEqual(denialDisplayData(counter, "task-x"), { count: 1, show: true });
  assert.deepEqual(denialDisplayData(counter, "task-y"), { count: 0, show: false });
});

test("reset 清零；byTask 是快照不被外部改", () => {
  const counter = createPermissionDenialCounter();
  counter.record("t", "deny");
  const snapshot = counter.byTask;
  snapshot.set("hacked", 999);
  assert.equal(counter.byTask.get("hacked"), undefined, "快照不可反向污染");
  counter.reset();
  assert.equal(counter.total, 0);
});
