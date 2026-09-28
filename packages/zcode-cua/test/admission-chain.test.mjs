// W-12/W-13 门禁:准入链(config 链产品判定/官方 lifecycle retention/resolver restart/registry)。
// isOfficialCuaPluginEnabledForWorkspace 语义 = G9 照抄官方 resolveOfficialCuaPluginEnablementState。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CuaHelperLifecycleManager,
  CuaProductHelperWorkspaceRegistry,
  createCuaProductMcpServerResolver,
  isOfficialCuaPluginEnabledForWorkspace,
} from "../broker-server.js";

const PLUGIN_ID = "computer-use@zcode-plugins-official";

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), "cua-admit-"));
  mkdirSync(join(home, ".freecodez", "cli"), { recursive: true });
  return home;
}

function writeUserConfig(home, config) {
  writeFileSync(join(home, ".freecodez", "cli", "config.json"), JSON.stringify(config), "utf8");
}

test("产品判定:无任何配置 ⇒ 默认关闭(官方 enabledPlugins 未设即 false)", () => {
  const home = tempHome();
  try {
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: { ZCODE_DATA_BASE_DIR: home } }), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("产品判定:user config enabledPlugins[computer-use]=true ⇒ true;显式 false ⇒ false", () => {
  const home = tempHome();
  try {
    writeUserConfig(home, { plugins: { enabledPlugins: { [PLUGIN_ID]: true } } });
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: { ZCODE_DATA_BASE_DIR: home } }), true);
    writeUserConfig(home, { plugins: { enabledPlugins: { [PLUGIN_ID]: false } } });
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: { ZCODE_DATA_BASE_DIR: home } }), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("产品判定:features.mcp=false 或 plugins.enabled=false 均压掉启用(官方语义)", () => {
  const home = tempHome();
  try {
    writeUserConfig(home, {
      features: { mcp: false },
      plugins: { enabledPlugins: { [PLUGIN_ID]: true } },
    });
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: { ZCODE_DATA_BASE_DIR: home } }), false);
    writeUserConfig(home, {
      plugins: { enabled: false, enabledPlugins: { [PLUGIN_ID]: true } },
    });
    assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: { ZCODE_DATA_BASE_DIR: home } }), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("产品判定:workspace 配置链(zcode.json/.freecodez/config.json)参与判定", () => {
  const home = tempHome();
  const project = mkdtempSync(join(tmpdir(), "cua-proj-"));
  try {
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(join(project, ".freecodez"), { recursive: true });
    writeUserConfig(home, { plugins: { enabledPlugins: { [PLUGIN_ID]: true } } });
    writeFileSync(join(project, ".freecodez", "config.json"), JSON.stringify({
      plugins: { enabledPlugins: { [PLUGIN_ID]: false } },
    }), "utf8");
    assert.equal(
      isOfficialCuaPluginEnabledForWorkspace({
        env: { ZCODE_DATA_BASE_DIR: home },
        workingDirectory: project,
      }),
      false,
      "workspace 覆盖 user(后读生效)",
    );
    writeFileSync(join(project, ".freecodez", "config.json"), JSON.stringify({
      plugins: { enabledPlugins: { [PLUGIN_ID]: true } },
    }), "utf8");
    assert.equal(
      isOfficialCuaPluginEnabledForWorkspace({
        env: { ZCODE_DATA_BASE_DIR: home },
        workingDirectory: project,
      }),
      true,
      "后读的同目录 .freecodez/config.json 覆盖先前值(官方源序)",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("LifecycleManager:acquire 保留 current(retention),create 仅一次;不满足准入时按 retention 退役", async () => {
  const stopped = [];
  let created = 0;
  const manager = new CuaHelperLifecycleManager(async (instance) => {
    stopped.push(instance);
  });
  const factory = (id) => ({ id });
  const first = await manager.acquire({
    isAdmitted: () => true,
    shouldRetainCurrent: () => true,
    create: () => {
      created += 1;
      return factory("a");
    },
  });
  assert.equal(first.id, "a");
  const second = await manager.acquire({
    isAdmitted: () => true,
    shouldRetainCurrent: () => true,
    create: () => factory("b"),
  });
  assert.equal(second.id, "a", "retention 下复用 current");
  assert.equal(created, 1, "create 只调一次");

  const third = await manager.acquire({
    isAdmitted: () => false,
    shouldRetainCurrent: () => false,
  });
  assert.equal(third, undefined, "不满足准入返回 undefined");
  assert.deepEqual(stopped.map((s) => s.id), ["a"], "retention=false 时退役现有实例");
  assert.equal(manager.peek(), undefined);
});

test("LifecycleManager:dispose 停止 current;重复 dispose 幂等", async () => {
  const stopped = [];
  const manager = new CuaHelperLifecycleManager(async (instance) => {
    stopped.push(instance.id);
  });
  await manager.acquire({ isAdmitted: () => true, shouldRetainCurrent: () => true, create: () => ({ id: "x" }) });
  await manager.dispose();
  await manager.dispose();
  assert.deepEqual(stopped, ["x"]);
  assert.equal(manager.disposed, true);
  assert.equal((await manager.acquire({ isAdmitted: () => true, create: () => ({ id: "y" }) })), undefined);
});

test("resolver.restart/restartAfterPermissionGrant:stop→start 真执行(S2-9)", async () => {
  const calls = [];
  const resolver = createCuaProductMcpServerResolver({
    stop: async () => calls.push("stop"),
    start: async () => calls.push("start"),
  });
  await resolver.restart();
  assert.deepEqual(calls, ["stop", "start"]);
  await resolver.restartAfterPermissionGrant();
  assert.deepEqual(calls, ["stop", "start", "stop", "start"]);
  const passthrough = await resolver.resolveMcpServers([{ name: "node_repl" }]);
  assert.deepEqual(passthrough, [{ name: "node_repl" }]);
});

test("registry:setEnabled 键控/快照/pruneDisabled(官方全套)", () => {
  const registry = new CuaProductHelperWorkspaceRegistry();
  registry.setEnabled({ workspaceKey: "ws-1", workspacePath: "/a" }, true);
  registry.setEnabled({ workspaceKey: "ws-2", workspacePath: "/b" }, true);
  registry.setEnabled({ workspaceKey: "ws-2" }, false);
  assert.equal(registry.snapshot().length, 1);
  assert.equal(registry.snapshot()[0].workspacePath, "/a");
  registry.setEnabled({ workspaceKey: "ws-3", workspaceIdentity: "id-3" }, true);
  registry.pruneDisabled((target) => Boolean(target.workspacePath));
  assert.deepEqual(
    registry.snapshot().map((target) => target.workspaceIdentity),
    [undefined],
    "pruneDisabled 移除 isEnabled=false 的目标",
  );
});
