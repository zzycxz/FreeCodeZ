#!/usr/bin/env node
// 自建薄 relay 启动器（node 直跑，无需构建）：node scripts/web-remote-relay.mjs
// 默认 127.0.0.1:37843（与 @zcode/shared/web-remote-control 默认端点一致）：
//   ZCODE_WEB_REMOTE_RELAY_PORT  覆盖端口
//   ZCODE_WEB_REMOTE_RELAY_HOST 覆盖监听地址（非回环部署时自行保证网络安全）
//   ZCODE_WEB_REMOTE_RELAY_LOG   日志级别 debug|info|warn|error|silent（默认 info）
//
// 仓库源码是 TS（NodeNext .js 惯用导入），这里先注册 tsx 的 ESM 加载器再动态导入 relay 源码；
// tsx 缺失时退回 node 原生 TS 导入（Node ≥22.18 需运行时支持 .js→.ts 解析）。

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const relayEntryUrl = pathToFileURL(
  resolve(rootDir, "packages/server/src/relay/webRemoteRelayServer.ts"),
).href;

async function loadRelayModule() {
  try {
    const tsxApi = await import("tsx/esm/api");
    tsxApi.register();
  } catch {
    process.stdout.write("[web-remote-relay] tsx 不可用，尝试 node 原生 TS 导入\n");
  }
  try {
    return await import(relayEntryUrl);
  } catch (error) {
    process.stderr.write(`[web-remote-relay] 加载 relay 源码失败：${String(error)}\n`);
    process.stderr.write(
      "[web-remote-relay] 提示：先在仓库根目录执行 pnpm install（启动器经 tsx 加载 TS 源码）\n",
    );
    process.exit(1);
  }
}

async function main() {
  const { createWebRemoteRelayServer } = await loadRelayModule();
  const host = process.env.ZCODE_WEB_REMOTE_RELAY_HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.ZCODE_WEB_REMOTE_RELAY_PORT) || 37843;
  const logLevel = process.env.ZCODE_WEB_REMOTE_RELAY_LOG?.trim() || "info";

  const relay = createWebRemoteRelayServer({ host, port, logLevel });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`[web-remote-relay] 收到 ${signal}，断开全部连接并退出\n`);
    try {
      await relay.close();
    } catch (error) {
      process.stderr.write(`[web-remote-relay] 关闭失败：${String(error)}\n`);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Windows：CTRL_C 无法被程序化定向投递到进程组，CTRL_BREAK（SIGBREAK）走同一优雅关闭路径。
  process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
}

void main().catch((error) => {
  process.stderr.write(`[web-remote-relay] 启动失败：${String(error)}\n`);
  process.exit(1);
});
