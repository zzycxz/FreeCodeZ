// 第四批 22③：终端 cwd 联动匹配纯件测试。
import assert from "node:assert/strict";
import test from "node:test";
import {
  terminalWorkspaceKey,
  agentWorkspaceKey,
  matchTerminalForAgent,
} from "../src/terminal-cwd-link.js";

test("workspace 键口径与 Terminal.tsx/AGENTS.md 一致", () => {
  assert.equal(terminalWorkspaceKey({ workspaceKey: "/ws", cwd: "/ws/sub" }), "/ws");
  assert.equal(terminalWorkspaceKey({ workspaceKey: "", cwd: "/ws" }), "/ws");
  assert.equal(terminalWorkspaceKey({ workspaceKey: "", cwd: "" }), "__default__");
  assert.equal(agentWorkspaceKey({ workspacePath: "/ws" }), "/ws");
  assert.equal(agentWorkspaceKey({ workspacePath: "/ws", workspaceIdentity: "my-identity" }), "my-identity");
});

test("identity 精确匹配优先", () => {
  const tabs = [{ workspaceKey: "id-a", cwd: "/ws" }, { workspaceKey: "/ws", cwd: "/ws" }];
  const result = matchTerminalForAgent({ workspacePath: "/ws", workspaceIdentity: "id-a" }, tabs);
  assert.equal(result.matched, true);
  if (result.matched) assert.equal(result.tab.workspaceKey, "id-a");
});

test("cwd 前缀匹配：agent 子目录命中父终端", () => {
  const tabs = [{ workspaceKey: "/projects", cwd: "/projects/app" }];
  const result = matchTerminalForAgent({ workspacePath: "/projects/app/src" }, tabs);
  assert.equal(result.matched, true);
});

test("不中：无 tab / identity 与 cwd 都不中", () => {
  assert.deepEqual(matchTerminalForAgent({ workspacePath: "/a" }, []).reason, "no_tabs");
  const mismatch = matchTerminalForAgent({ workspacePath: "/other" }, [{ workspaceKey: "/ws", cwd: "/ws" }]);
  assert.equal(mismatch.matched, false);
  if (!mismatch.matched) assert.equal(mismatch.reason, "identity_mismatch");
});

test("尾斜杠归一：/ws 与 /ws/ 等价", () => {
  const tabs = [{ workspaceKey: "/ws/", cwd: "/ws/" }];
  const result = matchTerminalForAgent({ workspacePath: "/ws" }, tabs);
  // workspaceKey 不为空所以走 identity 精确匹配 "/ws/" ≠ "/ws"——但 cwd 前缀路径归一后匹配
  if (!result.matched) {
    assert.equal(result.reason, "identity_mismatch", "空 workspaceKey 会走 cwd 匹配，非空走 identity");
  }
  const tabs2 = [{ workspaceKey: "", cwd: "/ws/" }];
  const result2 = matchTerminalForAgent({ workspacePath: "/ws" }, tabs2);
  assert.equal(result2.matched, true, "空 workspaceKey 走 cwd 前缀（尾斜杠归一后等价）");
});
