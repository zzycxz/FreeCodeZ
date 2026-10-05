// 0-2 修复测试（升级实施手册）：dangerouslyDisableSandbox 是模型可见参数且直通关沙箱——
// 提示注入可一句话关沙箱（yolo/bots 全放行、plan 只读直通、build 会话免确认全部静默）。
// 修复后该参数置真即 alwaysAsk：压过 yolo 直通与只读直通；携带该参数的调用不吃任何
// allow 规则（会话免确认按命令文本授予，注入可夹带）；deny/ask 规则照常生效。
// 不带该参数的既有行为（yolo 放行/只读放行/会话规则）零变化。
import assert from "node:assert/strict";
import test from "node:test";
import { PermissionService } from "../src/permission/service.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";
import { resolveRuntimePermissionCapability } from "../src/tool/executor/permission-capability.js";
import { resolveBashPermissionRulePolicy } from "../src/tool/handlers/bash-command-permission-policy.js";
import type { PermissionContext } from "../src/permission/service.js";
import type { PermissionRuleValue } from "@zcode/contracts";

function check(
  service: PermissionService,
  input: Record<string, unknown>,
  mode: "yolo" | "build" | "plan",
  options?: { planEnabled?: boolean; projectRules?: PermissionRuleValue[] },
) {
  const context: PermissionContext = {
    toolName: "Bash",
    input,
    riskLevel: "high",
    mode,
    ...(options?.planEnabled !== undefined ? { planEnabled: options.planEnabled } : {}),
  };
  return service.checkPermission(
    context,
    resolveRuntimePermissionCapability(bashToolEntry, input, { workingDirectory: "/repo" }),
    options?.projectRules
      ? ({ version: 1, allow: options.projectRules } as const)
      : null,
    resolveBashPermissionRulePolicy(input, { workingDirectory: "/repo" }),
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
