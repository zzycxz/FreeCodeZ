// B2 门禁:附录 B 错误映射表逐项断言(经 vendored SDK assertOk 的真实升级路径);
// A16 源码级占位标记归零;A16 的 14 工具挂载齐全对照。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { join } from "node:path";
import test from "node:test";
import {
  ComputerUseError,
  COMPUTER_METHOD_NAMES,
  setupComputerUseRuntime,
} from "../../../apps/zcode-cli/dependencies/zcode-cua/plugin/scripts/computer-use-client.mjs";
import { createComputerUseRuntime } from "../index.js";
import { TOOL_NAMES } from "../producer/tool-schema.js";
import { captureAppFixture, startMockHelper } from "./helpers/mock-helper.mjs";

const BRIDGE_SYMBOL = Symbol.for("zcode.node-repl.computer-use-bridge");
const CONTEXT = { sessionId: "map-1", runtimeScope: "main", workspaceKey: "ws-1" };

// 附录 B:broker 码 → [SDK 码, retry]。broker_unavailable/stale_socket 由 shouldPropagateToWrapper
// 同语义上抛到策略层走 CUA_NOT_READY 信封(单列断言),其余 15 行经 assertOk 映射。
const APPENDIX_B_ROWS = [
  ["permission_denied", "PERMISSION_DENIED", "never"],
  ["not_authorized", "NOT_AUTHORIZED", "never"],
  ["launch_failed", "LAUNCH_FAILED", "retry"],
  ["invalid_request", "INVALID_APP", "retry"],
  ["element_unavailable", "ELEMENT_UNAVAILABLE", "reobserve"],
  ["not_settable", "NOT_SETTABLE", "never"],
  ["not_selectable", "NOT_SELECTABLE", "never"],
  ["action_unavailable", "ACTION_UNAVAILABLE", "never"],
  ["foreground_required", "FOREGROUND_REQUIRED", "retry"],
  ["controller_busy", "CONTROLLER_BUSY", "never"],
  ["version_mismatch", "VERSION_MISMATCH", "never"],
  ["timeout", "TIMEOUT", "retry"],
  ["unimplemented", "ACTION_UNAVAILABLE", "never"],
  ["method_not_found", "INTERNAL", "retry"],
  ["internal", "INTERNAL", "retry"],
];
const NOT_READY_ROWS = ["broker_unavailable", "stale_socket"];

test("附录 B 映射:15 行 broker 码逐项过 assertOk 升级路径", async () => {
  let currentError = { code: "internal", message: "probe", details: { action_sent: false } };
  const helper = await startMockHelper({
    handlers: {
      capture_app: () => captureAppFixture(),
      element_set_value: () => ({ __error: currentError }),
    },
  });
  try {
    const runtime = createComputerUseRuntime({
      brokerSocketPath: helper.socketPath,
      platform: "win32",
      settleWindowMs: 0,
    });
    const globals = {
      [BRIDGE_SYMBOL]: {
        call: (method, args) =>
          runtime.execute({ toolName: method, arguments: args ?? {}, context: CONTEXT }),
        assertAvailable() {},
        documentationRoot: process.cwd(),
      },
      nodeRepl: { write() {}, emitStructuredResult() {} },
      agent: {},
    };
    const cua = await setupComputerUseRuntime({ globals });
    const app = await cua.getApp({ pid: 42 });
    for (const [brokerCode, sdkCode, retry] of APPENDIX_B_ROWS) {
      currentError = { code: brokerCode, message: `probe ${brokerCode}`, details: { action_sent: false } };
      await assert.rejects(
        () => app.setValue(1, "x"),
        (error) => {
          assert.ok(error instanceof ComputerUseError, `${brokerCode} 应抛 ComputerUseError`);
          assert.equal(error.code, sdkCode, `${brokerCode} 映射错`);
          assert.equal(error.retry, retry, `${brokerCode} retry 档错`);
          assert.equal(error.actionSent, false, `${brokerCode} actionSent 应为 false`);
          return true;
        },
        `${brokerCode} 未走升级路径`,
      );
    }
  } finally {
    await helper.close();
  }
});

test("附录 B 映射:broker_unavailable/stale_socket 归 CUA_NOT_READY 信封(上抛语义)", async () => {
  for (const brokerCode of NOT_READY_ROWS) {
    const helper = await startMockHelper({
      handlers: {
        capture_app: () => captureAppFixture(),
        element_set_value: () => ({
          __error: { code: brokerCode, message: "warmup", details: { request_delivery_state: "delivered" } },
        }),
      },
    });
    try {
      const runtime = createComputerUseRuntime({
        brokerSocketPath: helper.socketPath,
        platform: "win32",
        settleWindowMs: 0,
      });
      await runtime.execute({
        toolName: "get_app_state",
        arguments: { app_ref: { pid: 42 }, tree_shown_to_model: true },
        context: CONTEXT,
      });
      const result = await runtime.execute({
        toolName: "set_value",
        arguments: { target: { type: "element", index: 1 }, value: "x", app_ref: { pid: 42 } },
        context: CONTEXT,
      });
      assert.notEqual(result.isError, true, `${brokerCode} 应走 not-ready 信封而非错误信封`);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.kind, "CUA_NOT_READY");
      assert.equal(payload.retryable, true);
    } finally {
      await helper.close();
    }
  }
});

test("A16 源码级:占位标记在打包面源码 0 次", () => {
  const marker = "Computer Use is not available in this build";
  // 仓库根从本文件位置解析——cwd 可能是包目录（node --test 从包内跑）或根（runner 分组跑）。
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const roots = [
    join(repoRoot, "packages", "zcode-cua"),
    join(repoRoot, "packages", "services", "src"),
    join(repoRoot, "packages", "desktop", "src"),
    join(repoRoot, "apps", "zcode-cli", "packages", "node-repl-host", "src"),
  ];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "test" || entry === "node_modules" || entry === "dist" || entry === "out") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(js|mjs|ts|tsx)$/u.test(full)) continue;
      if (readFileSync(full, "utf8").includes(marker)) offenders.push(full);
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual(offenders, []);
});

test("A16 工具面:SDK 14 工具与 runtime schema 面逐一对齐", () => {
  assert.equal(COMPUTER_METHOD_NAMES.length, 14);
  assert.deepEqual([...COMPUTER_METHOD_NAMES].sort(), [...TOOL_NAMES].sort());
});
