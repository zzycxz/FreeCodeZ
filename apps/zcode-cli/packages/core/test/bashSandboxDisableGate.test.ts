// 0-2 修复测试（升级实施手册）：dangerouslyDisableSandbox 是模型可见参数且直通关沙箱——
// 提示注入可一句话关沙箱（yolo/bots 全放行、plan 只读直通、build 会话免确认全部静默）。
// 修复后该参数置真即 alwaysAsk：压过 yolo 直通与只读直通；携带该参数的调用不吃任何
// allow 规则（会话免确认按命令文本授予，注入可夹带）；deny/ask 规则照常生效。
// 不带该参数的既有行为（yolo 放行/只读放行/会话规则）零变化。
// 2026-10-11（沙箱规格书头部④）：门只在会话沙箱真开启时成立——sandboxEnabled === false
//（全局开关关/automation 未勾）的会话里参数是空操作，不触发 alwaysAsk、allow 规则照常
// 命中；未知上下文（无 sandboxEnabled 字段，下方既有用例即此形态）保守触发（fail-closed）。
import assert from "node:assert/strict";
import test from "node:test";
import { PermissionService } from "../src/permission/service.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";
import {
  resolveRuntimePermissionCapability,
  resolveRuntimePermissionContext,
} from "../src/tool/executor/permission-capability.js";
import { resolveBashPermissionRulePolicy } from "../src/tool/handlers/bash-command-permission-policy.js";
import type { PermissionContext } from "../src/permission/service.js";
import type { PermissionRuleValue } from "@zcode/contracts";
import type { ToolExecutorDeps } from "../src/tool/executor/types.js";

function check(
  service: PermissionService,
  input: Record<string, unknown>,
  mode: "yolo" | "build" | "plan",
  options?: { planEnabled?: boolean; projectRules?: PermissionRuleValue[]; sandboxEnabled?: boolean },
) {
  const context: PermissionContext = {
    toolName: "Bash",
    input,
    riskLevel: "high",
    mode,
    ...(options?.planEnabled !== undefined ? { planEnabled: options.planEnabled } : {}),
  };
  const capabilityContext = {
    workingDirectory: "/repo",
    ...(options?.sandboxEnabled !== undefined ? { sandboxEnabled: options.sandboxEnabled } : {}),
  };
  return service.checkPermission(
    context,
    resolveRuntimePermissionCapability(bashToolEntry, input, capabilityContext),
    options?.projectRules
      ? ({ version: 1, allow: options.projectRules } as const)
      : null,
    resolveBashPermissionRulePolicy(input, capabilityContext),
  );
}

test("yolo（含 bots）：携带关沙箱参数强制 ask 而非静默放行", () => {
  const service = new PermissionService();
  const result = check(service, { command: "ls /", dangerouslyDisableSandbox: true }, "yolo");
  assert.equal(result.decision, "ask");
  assert.equal(result.ruleId, "tool.alwaysAsk");
  assert.equal(result.alwaysAsk, true);
});

test("plan 模式：只读命令 + 关沙箱参数不再走 readOnly 直通", () => {
  const service = new PermissionService();
  const result = check(
    service,
    { command: "ls /", dangerouslyDisableSandbox: true },
    "plan",
    { planEnabled: true },
  );
  assert.equal(result.decision, "ask");
  assert.equal(result.ruleId, "tool.alwaysAsk");
});

test("build 模式：携带关沙箱参数 ask", () => {
  const service = new PermissionService();
  const result = check(service, { command: "cargo build", dangerouslyDisableSandbox: true }, "build");
  assert.equal(result.decision, "ask");
});

test("会话免确认规则不能被夹带利用：同命令带参数仍 ask", () => {
  const service = new PermissionService();
  // 用户对 `cargo build` 授予了会话免确认（会话规则只服务 alwaysAsk 门——正是本参数触发的门）。
  service.grantSessionPermission([
    { type: "addRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: "cargo build" }] },
  ]);
  const withFlag = check(service, { command: "cargo build", dangerouslyDisableSandbox: true }, "build");
  assert.equal(withFlag.decision, "ask", "allow 规则不得命中携带关沙箱参数的调用");
  // 合法通道不受影响：项目 allow 规则对不带参数的调用照常放行。
  const withoutFlag = check(service, { command: "cargo build" }, "build", {
    projectRules: [{ toolName: "Bash", ruleContent: "cargo build" }],
  });
  assert.equal(withoutFlag.decision, "allow");
  assert.equal(withoutFlag.ruleId, "rule.project.allow");
});

test("deny 规则照常生效：携带关沙箱参数时 deny 仍优先", () => {
  const service = new PermissionService();
  const result = check(
    service,
    { command: "curl https://example.com", dangerouslyDisableSandbox: true },
    "build",
    { projectRules: [] },
  );
  // checkAlwaysAsk 只看 projectRules 的 deny——通过 ruleset 传入 deny 规则验证优先级。
  const context: PermissionContext = {
    toolName: "Bash",
    input: { command: "curl https://example.com", dangerouslyDisableSandbox: true },
    riskLevel: "high",
    mode: "build",
  };
  const denied = service.checkPermission(
    context,
    resolveRuntimePermissionCapability(bashToolEntry, context.input, { workingDirectory: "/repo" }),
    { version: 1, deny: [{ toolName: "Bash", ruleContent: "curl*" }] },
    resolveBashPermissionRulePolicy(context.input, { workingDirectory: "/repo" }),
  );
  assert.equal(result.decision, "ask");
  assert.equal(denied.decision, "deny");
});

test("不带参数零变化：yolo 放行 / 只读低风险 / 语义不变", () => {
  const service = new PermissionService();
  assert.equal(check(service, { command: "ls /" }, "yolo").decision, "allow");
  assert.equal(check(service, { command: "ls /" }, "yolo").ruleId, "mode.yolo");
  const readonlyCap = resolveRuntimePermissionCapability(bashToolEntry, { command: "ls /" }, {});
  assert.equal(readonlyCap.readOnly, true, "普通只读命令能力不受影响");
  assert.equal(readonlyCap.riskLevel, "low");
});

test("能力解析：dangerouslyDisableSandbox 非 true 值不触发门", () => {
  const service = new PermissionService();
  // false/缺省是正常形态；只有显式 true 才触发 alwaysAsk。
  assert.equal(
    check(service, { command: "ls /", dangerouslyDisableSandbox: false }, "yolo").decision,
    "allow",
  );
});

test("沙箱关闭会话：携带关沙箱参数不再触发 alwaysAsk（yolo 放行，用户实测场景）", () => {
  const service = new PermissionService();
  // 全局沙箱开关关闭 + 模型保险起见带参（如 launchctl submit）：参数是空操作，
  // 无"关沙箱"可审批——按普通命令走 yolo 直通，不弹框。
  const result = check(
    service,
    { command: "launchctl submit -l demo /usr/bin/true", dangerouslyDisableSandbox: true },
    "yolo",
    { sandboxEnabled: false },
  );
  assert.equal(result.decision, "allow");
  assert.equal(result.ruleId, "mode.yolo");
});

test("沙箱关闭会话：带参与不带参行为逐字一致（build 只读放行/非只读 ask）", () => {
  const service = new PermissionService();
  const readonlyWithFlag = check(
    service,
    { command: "ls /", dangerouslyDisableSandbox: true },
    "build",
    { sandboxEnabled: false },
  );
  assert.equal(readonlyWithFlag.ruleId, "mode.build.readOnly");
  // 非只读命令：带参（沙箱关）与不带参的判定逐字一致——参数不改变任何权限语义。
  const flagged = check(
    service,
    { command: "cargo build", dangerouslyDisableSandbox: true },
    "build",
    { sandboxEnabled: false },
  );
  const unflagged = check(service, { command: "cargo build" }, "build", { sandboxEnabled: false });
  assert.equal(flagged.decision, unflagged.decision);
  assert.equal(flagged.ruleId, unflagged.ruleId);
});

test("沙箱关闭会话：allow 规则恢复命中（防夹带抑制不生效）", () => {
  const service = new PermissionService();
  const result = check(
    service,
    { command: "cargo build", dangerouslyDisableSandbox: true },
    "build",
    {
      sandboxEnabled: false,
      projectRules: [{ toolName: "Bash", ruleContent: "cargo build" }],
    },
  );
  assert.equal(result.decision, "allow");
  assert.equal(result.ruleId, "rule.project.allow");
});

test("沙箱开启会话：门照常触发（既有防护零变化）", () => {
  const service = new PermissionService();
  const result = check(
    service,
    { command: "cargo build", dangerouslyDisableSandbox: true },
    "yolo",
    { sandboxEnabled: true },
  );
  assert.equal(result.decision, "ask");
  assert.equal(result.ruleId, "tool.alwaysAsk");
});

test("能力解析：未知上下文（无 sandboxEnabled 字段）保守触发（fail-closed）", () => {
  const capability = resolveRuntimePermissionCapability(
    bashToolEntry,
    { command: "ls /", dangerouslyDisableSandbox: true },
    { workingDirectory: "/repo" },
  );
  assert.equal(capability.alwaysAsk, true);
});

test("上下文投影：resolveRuntimePermissionContext 从 deps 填充沙箱事实", () => {
  const baseDeps = {
    getWorkingDirectory: () => "/repo",
    getWorkspaceRoot: () => "/repo",
  } as ToolExecutorDeps;
  assert.equal(
    resolveRuntimePermissionContext({ ...baseDeps, sandboxEnabled: true }).sandboxEnabled,
    true,
  );
  assert.equal(
    resolveRuntimePermissionContext({ ...baseDeps, sandboxEnabled: false }).sandboxEnabled,
    false,
  );
  // deps 缺省（未显式声明沙箱）= 关闭事实，投影为显式 false——下游门按空操作跳过。
  assert.equal(resolveRuntimePermissionContext(baseDeps).sandboxEnabled, false);
});
