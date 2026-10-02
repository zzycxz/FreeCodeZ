// A1 单测：自动化会话（cron/闲时）创建时注入审批超时缺省 120s，交互会话不注入。
// 背景：cron 缺省 build 模式写操作必 ask，无人值守时无超时即永久挂起（派发侧无看门狗）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOMATION_PERMISSION_TIMEOUT_MS,
  resolveAutomationPermissionTimeoutMs,
} from "../src/zcode-agent/automationToolPolicy.js";
import { zcodeSessionCreateParamsSchema } from "@zcode/shared";

test("cron automation 会话解析出 120s 缺省超时", () => {
  assert.equal(
    resolveAutomationPermissionTimeoutMs({ automationId: "auto-1" }),
    AUTOMATION_PERMISSION_TIMEOUT_MS,
  );
  assert.equal(AUTOMATION_PERMISSION_TIMEOUT_MS, 120_000);
});

test("闲时会话同样解析出缺省超时", () => {
  assert.equal(
    resolveAutomationPermissionTimeoutMs({ offPeakTaskId: "offpeak-1" }),
    AUTOMATION_PERMISSION_TIMEOUT_MS,
  );
});

test("交互会话不注入（保持无限等待用户应答的现状语义）", () => {
  assert.equal(resolveAutomationPermissionTimeoutMs({}), undefined);
  assert.equal(resolveAutomationPermissionTimeoutMs({}), undefined);
});

test("协议 schema 接受可选 permissionTimeoutMs 并拒绝非法值", () => {
  const base = {
    workspace: { workspacePath: "/tmp/ws", workspaceKey: "/tmp/ws" },
  };
  assert.equal(
    zcodeSessionCreateParamsSchema.parse({ ...base, permissionTimeoutMs: 120_000 })
      .permissionTimeoutMs,
    120_000,
  );
  assert.equal(
    zcodeSessionCreateParamsSchema.parse(base).permissionTimeoutMs,
    undefined,
  );
  // 非正整数/超上限拒绝：防止误传秒级小值或天文数字。
  assert.throws(() => zcodeSessionCreateParamsSchema.parse({ ...base, permissionTimeoutMs: 0 }));
  assert.throws(() =>
    zcodeSessionCreateParamsSchema.parse({ ...base, permissionTimeoutMs: 999_999_999 }),
  );
});
