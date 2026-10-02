// A3 回归测试：服务器编辑表单保存必须原样透传 disabledTools（工具级开关的唯一
// 写路径是工具清单弹窗），否则整键 upsert 会把用户已关闭的工具静默重新打开。
import assert from "node:assert/strict";
import test from "node:test";
import { buildMcpServerSaveConfig, EMPTY_FORM } from "../src/settings/mcpSettingsShared.js";
import type { ZCodeMcpServer } from "@zcode/shared";

function makePrev(overrides?: Partial<ZCodeMcpServer>): ZCodeMcpServer {
  return {
    name: "demo",
    scope: "user",
    enabled: true,
    status: "connected",
    config: { type: "stdio", command: "node", args: ["server.js"] },
    ...overrides,
  } as ZCodeMcpServer;
}

test("编辑保存透传 prev 的 disabledTools", () => {
  const prev = makePrev({
    config: { type: "stdio", command: "node", args: ["server.js"], disabledTools: ["a", "b"] },
  });
  const config = buildMcpServerSaveConfig({ ...EMPTY_FORM, type: "stdio", command: "node", args: "server.js --verbose" }, prev);
  assert.deepEqual(config.disabledTools, ["a", "b"]);
  // 表单字段本身照常生效
  assert.deepEqual(config.args, ["server.js", "--verbose"]);
});

test("prev 无 disabledTools 时不引入空字段", () => {
  const config = buildMcpServerSaveConfig({ ...EMPTY_FORM, type: "stdio", command: "node" }, makePrev());
  assert.equal(config.disabledTools, undefined);
});

test("空数组视为未设置（避免空名单覆盖语义歧义）", () => {
  const prev = makePrev({
    config: { type: "stdio", command: "node", disabledTools: [] },
  });
  const config = buildMcpServerSaveConfig({ ...EMPTY_FORM, type: "stdio", command: "node" }, prev);
  assert.equal(config.disabledTools, undefined);
});

test("enable=false 的既有行为保持：禁用的服务器保存后仍禁用", () => {
  const prev = makePrev({ enabled: false });
  const config = buildMcpServerSaveConfig({ ...EMPTY_FORM, type: "stdio", command: "node" }, prev);
  assert.equal(config.enable, false);
});

test("新建（无 prev）不携带任何透传字段", () => {
  const config = buildMcpServerSaveConfig({ ...EMPTY_FORM, type: "stdio", command: "node" });
  assert.equal(config.enable, undefined);
  assert.equal(config.disabledTools, undefined);
});
