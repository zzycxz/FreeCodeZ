// V1.17 生效链 + 注册门禁回归：
// ①注册门从「browser-use 已启用」改「browser-use 或 computer-use 任一启用」（definitions
//   注释既定语义，原实现漏接 computer-use 侧——CUA skill 插件启用后宿主必须拉得起）。
// ②桌面设置总开关经 FREECODEZ_CUA_CONTROL_ENABLED env 下发（"0"=关），
//   withComputerEngineEnv 注入 FREECODEZ_CUA_DISABLED 让 bridge 显式拒——
//   产品开关拒绝与 sidecar 产物缺失是两种失败面，分开报（fail-closed 两层）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withComputerEngineEnv } from "../src/mcp-config.js";
import {
  OFFICIAL_BROWSER_USE_PLUGIN_ID,
  OFFICIAL_COMPUTER_USE_PLUGIN_ID,
  OFFICIAL_NODE_REPL_HOST_PLUGIN_ID,
} from "../src/app/official-plugin-definitions.js";
import { resolveBuiltInNodeReplMcpServers } from "../src/app/built-in-node-repl.js";
import { FREECODEZ_CUA_ACTIONS_ENABLED_ENV, FREECODEZ_CUA_CONTROL_ENABLED_ENV } from "@zcode/shared/runtime-env";

function pluginEntry(id: string, enabled: boolean) {
  return { id, enabled, rootPath: `/tmp/fake-plugin-root/${id}` };
}

function makePluginOutcome(entries: ReturnType<typeof pluginEntry>[]) {
  // 宿主 seed 单元必须同时在场（resolveBuiltInNodeReplMcpServers 先找宿主再谈注册）。
  return {
    plugins: [pluginEntry(OFFICIAL_NODE_REPL_HOST_PLUGIN_ID, true), ...entries],
  } as unknown as Parameters<typeof resolveBuiltInNodeReplMcpServers>[0]["pluginOutcome"];
}

function withControlEnv(value: string | undefined, run: () => void): void {
  const previous = process.env[FREECODEZ_CUA_CONTROL_ENABLED_ENV];
  try {
    if (value === undefined) delete process.env[FREECODEZ_CUA_CONTROL_ENABLED_ENV];
    else process.env[FREECODEZ_CUA_CONTROL_ENABLED_ENV] = value;
    run();
  } finally {
    if (previous === undefined) delete process.env[FREECODEZ_CUA_CONTROL_ENABLED_ENV];
    else process.env[FREECODEZ_CUA_CONTROL_ENABLED_ENV] = previous;
  }
}

test("withComputerEngineEnv：开关关 → 注入 DISABLED 且不注入引擎键（显式关优先于产物在场）", () => {
  const env = withComputerEngineEnv({}, {
    engineDistDir: "/fake/engine-dist",
    engineReady: true,
    controlEnabled: false,
  });
  assert.equal(env.FREECODEZ_CUA_DISABLED, "1");
  assert.equal(env.FREECODEZ_CUA_ENGINE_READY, undefined);
  assert.equal(env.FREECODEZ_CUA_ENGINE_SIDECAR, undefined);
});

test("withComputerEngineEnv：开关开/未声明 + 产物在场 → 注入引擎键且无 DISABLED", () => {  for (const controlEnabled of [true, undefined]) {
    const env = withComputerEngineEnv({}, {
      engineDistDir: "/fake/engine-dist",
      engineReady: true,
      controlEnabled,
    });
    assert.equal(env.FREECODEZ_CUA_DISABLED, undefined);
    assert.equal(env.FREECODEZ_CUA_ENGINE_READY, "1");
    assert.equal(env.FREECODEZ_CUA_ENGINE_SIDECAR, "/fake/engine-dist");
  }
});

test("动作层门（V1.19 P1）：actionsEnabled=false → FREECODEZ_CUA_ACTIONS=0 且引擎键照常注入", () => {
  const env = withComputerEngineEnv({}, {
    engineDistDir: "/fake/engine-dist",
    engineReady: true,
    controlEnabled: true,
    actionsEnabled: false,
  });
  assert.equal(env.FREECODEZ_CUA_ACTIONS, "0");
  assert.equal(env.FREECODEZ_CUA_ENGINE_READY, "1");
  assert.equal(env.FREECODEZ_CUA_DISABLED, undefined);
  // 未声明（headless CLI 缺省）=不设门。
  const ungated = withComputerEngineEnv({}, { engineDistDir: "/d", engineReady: true });
  assert.equal(ungated.FREECODEZ_CUA_ACTIONS, undefined);
});

test("动作层门生效链：ACTIONS_ENABLED=0 → node_repl env 携带 FREECODEZ_CUA_ACTIONS=0", () => {
  const makeServers = () =>
    resolveBuiltInNodeReplMcpServers({
      pluginOutcome: makePluginOutcome([pluginEntry(OFFICIAL_COMPUTER_USE_PLUGIN_ID, true)]),
      workingDirectory: "/tmp/ws",
    });
  const previous = process.env[FREECODEZ_CUA_ACTIONS_ENABLED_ENV];
  try {
    process.env[FREECODEZ_CUA_ACTIONS_ENABLED_ENV] = "0";
    const env = makeServers().node_repl?.env as Record<string, string>;
    assert.equal(env.FREECODEZ_CUA_ACTIONS, "0");
    delete process.env[FREECODEZ_CUA_ACTIONS_ENABLED_ENV];
    const env2 = makeServers().node_repl?.env as Record<string, string>;
    assert.equal(env2.FREECODEZ_CUA_ACTIONS, undefined, "缺省不设门");
    process.env[FREECODEZ_CUA_ACTIONS_ENABLED_ENV] = "1";
    const env3 = makeServers().node_repl?.env as Record<string, string>;
    assert.equal(env3.FREECODEZ_CUA_ACTIONS, undefined);
  } finally {
    if (previous === undefined) delete process.env[FREECODEZ_CUA_ACTIONS_ENABLED_ENV];
    else process.env[FREECODEZ_CUA_ACTIONS_ENABLED_ENV] = previous;
  }
});

test("注册门禁：仅 computer-use 启用也注册 node_repl（原实现漏接此侧）", () => {
  withControlEnv(undefined, () => {
    const servers = resolveBuiltInNodeReplMcpServers({
      pluginOutcome: makePluginOutcome([pluginEntry(OFFICIAL_COMPUTER_USE_PLUGIN_ID, true)]),
      workingDirectory: "/tmp/ws",
    });
    assert.ok(servers.node_repl, "computer-use 单独启用时宿主必须注册");
    assert.equal(
      (servers.node_repl?.env as Record<string, string>).ZCODE_PLUGIN_ROOT,
      undefined,
      "browser-use 缺席时不得注入其领域 root",
    );
  });
});

test("注册门禁：仅 browser-use 启用照旧注册并注入其领域 root", () => {
  withControlEnv(undefined, () => {
    const servers = resolveBuiltInNodeReplMcpServers({
      pluginOutcome: makePluginOutcome([pluginEntry(OFFICIAL_BROWSER_USE_PLUGIN_ID, true)]),
      workingDirectory: "/tmp/ws",
    });
    assert.ok(servers.node_repl);
    assert.ok((servers.node_repl?.env as Record<string, string>).ZCODE_PLUGIN_ROOT);
  });
});

test("注册门禁：两者都未启用 → 不注册", () => {
  withControlEnv(undefined, () => {
    const servers = resolveBuiltInNodeReplMcpServers({
      pluginOutcome: makePluginOutcome([
        pluginEntry(OFFICIAL_BROWSER_USE_PLUGIN_ID, false),
        pluginEntry(OFFICIAL_COMPUTER_USE_PLUGIN_ID, false),
      ]),
      workingDirectory: "/tmp/ws",
    });
    assert.deepEqual(servers, {});
  });
});

test("生效链：CONTROL_ENABLED=0 → node_repl env 携带 DISABLED；=1/缺省 → 不带", () => {
  const makeServers = () =>
    resolveBuiltInNodeReplMcpServers({
      pluginOutcome: makePluginOutcome([pluginEntry(OFFICIAL_COMPUTER_USE_PLUGIN_ID, true)]),
      workingDirectory: "/tmp/ws",
    });
  withControlEnv("0", () => {
    const env = makeServers().node_repl?.env as Record<string, string>;
    assert.equal(env.FREECODEZ_CUA_DISABLED, "1");
  });
  for (const value of ["1", undefined]) {
    withControlEnv(value, () => {
      const env = makeServers().node_repl?.env as Record<string, string>;
      assert.equal(env.FREECODEZ_CUA_DISABLED, undefined);
    });
  }
});

test("生效链：开关开 + sidecar 产物在场（workingDirectory 候选）→ 引擎键注入", () => {
  const root = mkdtempSync(join(tmpdir(), "cua-gate-"));
  try {
    const engineDist = join(root, "computer-engine", "dist");
    mkdirSync(engineDist, { recursive: true });
    writeFileSync(join(engineDist, "computer-sidecar.js"), "// sidecar\n");
    withControlEnv("1", () => {
      const servers = resolveBuiltInNodeReplMcpServers({
        pluginOutcome: makePluginOutcome([pluginEntry(OFFICIAL_COMPUTER_USE_PLUGIN_ID, true)]),
        workingDirectory: join(root, "ws"),
      });
      const env = servers.node_repl?.env as Record<string, string>;
      assert.equal(env.FREECODEZ_CUA_ENGINE_READY, "1");
      assert.equal(env.FREECODEZ_CUA_DISABLED, undefined);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
