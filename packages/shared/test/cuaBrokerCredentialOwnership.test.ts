// R16.1（FC/ZCode 互独立）：CUA broker 凭据归属 fail-closed 的单元测试（spec §4 R16.1/§7 A21/A22）。
// 威胁模型：宿主 ZCode 会话的凭据组（socket 指向 ZCode 的 broker）经 open 转发/终端直启泄漏进
// FC 进程 env——捕获面与 bootstrap env 兜底面都必须拒收，FC 绝不连 ZCode 的 helper broker。
import assert from "node:assert/strict";
import test from "node:test";
import {
  getCapturedZCodeCuaBrokerCredentials,
  resetCapturedZCodeCuaBrokerCredentialsForTest,
  sanitizeZCodeRuntimeEnv,
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
} from "../src/runtimeEnv.js";
import { mintBrokerSocketPath } from "@zcode/zcode-cua/broker/socketPath";

// ZCode 官方 darwin socket 公式（与 FC 品牌化路径 /tmp/freecodez-cua-<uid> 仅目录前缀之差）。
const foreignZCodeSocket = `/tmp/zcode-cua-${process.getuid?.() ?? "nouid"}/broker.sock`;

function reset(): void {
  resetCapturedZCodeCuaBrokerCredentialsForTest();
}

test("A21: 外来 socket（ZCode 形态）成组注入 → 捕获快照为空，不采信", () => {
  reset();
  sanitizeZCodeRuntimeEnv({
    [ZCODE_CUA_BROKER_SOCKET_ENV_KEY]: foreignZCodeSocket,
    [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: "config-provenance-random",
  });
  const captured = getCapturedZCodeCuaBrokerCredentials();
  assert.equal(captured.socket, undefined);
  assert.equal(captured.pluginAuthority, undefined);
});

test("A21: 外来 socket 单独出现（无 authority）→ 同样拒收整组", () => {
  reset();
  sanitizeZCodeRuntimeEnv({
    [ZCODE_CUA_BROKER_SOCKET_ENV_KEY]: foreignZCodeSocket,
  });
  assert.equal(getCapturedZCodeCuaBrokerCredentials().socket, undefined);
});

test("A21: 外来 socket 拒收告警按路径去重（重复注入只 warn 一次）", () => {
  reset();
  // 告警去重 Set 是模块级且测试间共享：本用例必须用独立的外来路径，
  // 否则前面用例已把 foreignZCodeSocket 计入去重集，这里首次注入也不再告警。
  const dedupePath = `/tmp/zcode-cua-${process.getuid?.() ?? "nouid"}-dedupe/broker.sock`;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(String(args[0]));
  };
  try {
    sanitizeZCodeRuntimeEnv({ [ZCODE_CUA_BROKER_SOCKET_ENV_KEY]: dedupePath });
    sanitizeZCodeRuntimeEnv({ [ZCODE_CUA_BROKER_SOCKET_ENV_KEY]: dedupePath });
  } finally {
    console.warn = originalWarn;
  }
  const rejected = warnings.filter((line) => line.includes("[cua.broker]"));
  assert.equal(rejected.length, 1);
  assert.match(rejected[0] ?? "", /Rejected foreign broker credential socket/);
});

test("A22: 自家 mint 路径 + authority 成组 → 捕获成功（R16 主链不伤）", () => {
  reset();
  sanitizeZCodeRuntimeEnv({
    [ZCODE_CUA_BROKER_SOCKET_ENV_KEY]: mintBrokerSocketPath(),
    [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: "config-provenance-random",
  });
  const captured = getCapturedZCodeCuaBrokerCredentials();
  assert.equal(captured.socket, mintBrokerSocketPath());
  assert.equal(captured.pluginAuthority, "config-provenance-random");
});

test("A19 回归: sanitize 输出 env 不携带凭据键（无论归属）", () => {
  reset();
  const sanitized = sanitizeZCodeRuntimeEnv({
    [ZCODE_CUA_BROKER_SOCKET_ENV_KEY]: foreignZCodeSocket,
    [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: "config-provenance-random",
  });
  assert.equal(sanitized[ZCODE_CUA_BROKER_SOCKET_ENV_KEY], undefined);
  assert.equal(sanitized[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY], undefined);
});
