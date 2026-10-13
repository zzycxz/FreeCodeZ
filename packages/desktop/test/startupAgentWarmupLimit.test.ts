// U1-3（移植自 ZCode 3.15.1）启动预热目标不变量：只预热当前激活的 1 个 workspace——
// 上游判定并发预热多个 agent 子进程造成多工作区启动卡顿（3→1）。
import assert from "node:assert/strict";
import test from "node:test";
import { resolveStartupAgentWarmupTargets } from "../src/main/startupWorkspace.js";

const active = { workspacePath: "/tmp/active-ws" };

test("最近项目再多也只保留当前激活 1 个预热目标", () => {
  const targets = resolveStartupAgentWarmupTargets(
    {
      recentProjects: [
        "/tmp/recent-1",
        "/tmp/recent-2",
        "/tmp/recent-3",
        "/tmp/active-ws",
      ],
    },
    active,
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.workspacePath, "/tmp/active-ws");
});

test("无最近项目时预热当前激活 1 个", () => {
  const targets = resolveStartupAgentWarmupTargets({ recentProjects: [] }, active);
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.workspacePath, "/tmp/active-ws");
});
