// FreeCodeZ fork(2026-09-24 移动端远程控制):弹窗判定纯逻辑单测——11 失败语义横幅映射
// (含 session-conflict 的 kicked 分流)、自动启动的会话复用判据(isSameContextSession/
// isMobileConnectedSession,workspaceKey=identity?.trim()||path)、状态全字段判等防抖、
// 手机正在操作绿标 key。合同见 docs/spec/web-remote-control.md §1/§3。
// 运行:cd packages/ui && node --import tsx --test test/webRemoteControlDialogLogic.test.ts
// (含 @/ 别名导入,必须在包目录内跑,见 build-env-traps §4)
import assert from "node:assert/strict";
import test from "node:test";

import { resolveWebRemoteControlFailureMessage } from "../src/web-remote-control/webRemoteControlFailure.js";
import {
  buildMobileActiveTaskKey,
  isMobileConnectedSession,
  isSameContextSession,
  webRemoteControlStatusEquals,
  type WebRemoteControlStatusSnapshot,
} from "../src/web-remote-control/useWebRemoteControlStatus.js";

const formatMessage = ({ id }: { id: string }): string => id;

function status(overrides: Partial<WebRemoteControlStatusSnapshot> = {}): WebRemoteControlStatusSnapshot {
  return {
    status: "running",
    sessionId: "s1",
    windowControlSessionId: "w1",
    mobileConnected: false,
    qrUrl: "qr",
    connectUrl: "link",
    workspacePath: "/repo",
    ...overrides,
  };
}

test("失败横幅:11 reason 映射到 failure.* 键", () => {
  const reasons = [
    "session-not-found",
    "session-expired",
    "session-conflict",
    "workspace-closed",
    "desktop-disconnected",
    "invalid-mobile-connection",
    "desktop-bootstrap-timeout",
    "connection-recovery-timeout",
    "relay-unavailable",
    "unsupported-action",
    "unexpected-error",
  ] as const;
  for (const reason of reasons) {
    const resolved = resolveWebRemoteControlFailureMessage({ reason, message: "" }, formatMessage);
    assert.equal(resolved?.startsWith("webRemoteControl.failure."), true, reason);
  }
  assert.equal(resolveWebRemoteControlFailureMessage(null, formatMessage), null);
});

test("失败横幅:session-conflict 含 kicked 分流到 failure.kicked(大小写不敏感)", () => {
  assert.equal(
    resolveWebRemoteControlFailureMessage(
      { reason: "session-conflict", message: "Pairing KICKED by relay" },
      formatMessage,
    ),
    "webRemoteControl.failure.kicked",
  );
  assert.equal(
    resolveWebRemoteControlFailureMessage(
      { reason: "session-conflict", message: "link occupied" },
      formatMessage,
    ),
    "webRemoteControl.failure.sessionConflict",
  );
});

test("自动启动复用判据:同 workspaceKey + 同 remoteSessionId + 有会话才复用", () => {
  const base = status();
  assert.equal(
    isSameContextSession(base, { workspacePath: "/repo" }),
    true,
    "同路径同上下文应复用",
  );
  assert.equal(isSameContextSession(status({ status: "idle" }), { workspacePath: "/repo" }), false);
  assert.equal(isSameContextSession(status({ status: "error" }), { workspacePath: "/repo" }), false);
  assert.equal(
    isSameContextSession(status({ workspacePath: "/other" }), { workspacePath: "/repo" }),
    false,
    "不同 workspace 不复用",
  );
  assert.equal(
    isSameContextSession(base, { workspacePath: "/repo", workspaceIdentity: "remote:ssh:x" }),
    false,
    "远程身份不能仅按路径匹配",
  );
  assert.equal(
    isSameContextSession(
      status({ workspaceIdentity: "remote:ssh:x", remoteSessionId: "r1" }),
      { workspacePath: "/repo", workspaceIdentity: "remote:ssh:x", remoteSessionId: "r1" },
    ),
    true,
  );
  assert.equal(
    isSameContextSession(
      status({ workspaceIdentity: "remote:ssh:x", remoteSessionId: "r1" }),
      { workspacePath: "/repo", workspaceIdentity: "remote:ssh:x", remoteSessionId: "r2" },
    ),
    false,
    "remoteSessionId 不同不复用",
  );
  assert.equal(
    isSameContextSession(status({ windowControlSessionId: "" }), { workspacePath: "/repo" }),
    false,
    "无会话 id 不复用",
  );
});

test("自动启动复用判据:手机已连接的会话不打断", () => {
  assert.equal(isMobileConnectedSession(status({ mobileConnected: true })), true);
  assert.equal(isMobileConnectedSession(status({ mobileConnected: false })), false);
  assert.equal(
    isMobileConnectedSession(status({ mobileConnected: true, status: "idle" })),
    false,
  );
  assert.equal(
    isMobileConnectedSession(status({ mobileConnected: true, windowControlSessionId: "" })),
    false,
  );
});

test("状态判等:同值防抖、异值(含 failure/mobileViewState 细节)必判异", () => {
  const base = status();
  assert.equal(webRemoteControlStatusEquals(base, { ...base }), true);
  assert.equal(webRemoteControlStatusEquals(base, status({ mobileConnected: true })), false);
  assert.equal(
    webRemoteControlStatusEquals(
      status({ failure: { reason: "kicked" as never, message: "a" } }),
      status({ failure: { reason: "kicked" as never, message: "b" } }),
    ),
    false,
  );
  assert.equal(
    webRemoteControlStatusEquals(
      status({ mobileViewState: { activeTaskId: "t1", updatedAt: 1 } }),
      status({ mobileViewState: { activeTaskId: "t2", updatedAt: 1 } }),
    ),
    false,
  );
  assert.equal(webRemoteControlStatusEquals(undefined, undefined), true);
  assert.equal(webRemoteControlStatusEquals(base, undefined), false);
});

test("手机正在操作绿标 key:mobileConnected + 双 key 齐全才产出", () => {
  assert.equal(
    buildMobileActiveTaskKey(
      status({
        mobileConnected: true,
        mobileViewState: { activeWorkspaceKey: "/repo", activeTaskId: "t1", updatedAt: 1 },
      }),
    ),
    "/repo:t1",
  );
  assert.equal(
    buildMobileActiveTaskKey(
      status({ mobileViewState: { activeWorkspaceKey: "/repo", activeTaskId: "t1", updatedAt: 1 } }),
    ),
    null,
    "未连接不上绿标",
  );
  assert.equal(
    buildMobileActiveTaskKey(status({ mobileConnected: true })),
    null,
    "缺 viewState 不上绿标",
  );
});
