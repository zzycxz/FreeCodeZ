import test from "node:test";
import assert from "node:assert/strict";
import { createEmbeddedRelayController } from "../src/main/webRemoteControl/embeddedRelay.js";

// 内嵌 LAN relay 控制器生命周期（spec web-remote-control §5）：懒启动/端口顺延/
// refcount 关停/外部模式跳过/失败回滚。模块保持 electron 无关，用假 createServer 驱动。

interface FakeServer {
  listeningListeners: Array<() => void>;
  errorListeners: Array<(error: Error) => void>;
  closeCount: number;
}

type CreateServerFn = Parameters<typeof createEmbeddedRelayController>[0]["createServer"];

function createFakeServerHandles() {
  const servers: FakeServer[] = [];
  const state: {
    busyPorts: Set<number>;
    failAllPorts: boolean;
  } = { busyPorts: new Set(), failAllPorts: false };

  const rawCreateServer = async (options: { port: number }) => {
    const fake: FakeServer = {
      listeningListeners: [],
      errorListeners: [],
      closeCount: 0,
    };
    servers.push(fake);
    const relay = {
      server: {
        once(event: string, listener: (...args: never[]) => void) {
          if (event === "listening") fake.listeningListeners.push(listener as () => void);
          if (event === "error") fake.errorListeners.push(listener as (error: Error) => void);
        },
      },
      close: async () => {
        fake.closeCount += 1;
      },
    };
    if (state.failAllPorts || state.busyPorts.has(options.port)) {
      // 宏任务触发 listen error（模拟 EADDRINUSE 异步到达；微任务会早于监听器挂载）。
      setTimeout(() => fake.errorListeners.forEach((fn) => fn(new Error("EADDRINUSE"))), 0);
    } else {
      setTimeout(() => fake.listeningListeners.forEach((fn) => fn()), 0);
    }
    return relay;
  };

  // 假 server 只实现控制器实际消费的面（once/close）；断言型转成 deps 期望的完整类型。
  const createServer = rawCreateServer as unknown as CreateServerFn;
  return { servers, state, createServer };
}

function createLogger() {
  const entries: string[] = [];
  return {
    entries,
    debug: () => undefined,
    info: (message: string) => entries.push(message),
    warn: (message: string) => entries.push(message),
    error: (message: string) => entries.push(message),
  };
}

test("懒启动 + 端口顺延：首端口被占时落到下一候选，端点用实际端口与 LAN 地址", async () => {
  const handles = createFakeServerHandles();
  handles.state.busyPorts.add(37843);
  const logger = createLogger();
  const controller = createEmbeddedRelayController({
    logger,
    env: {},
    resolveLanHost: async () => "192.168.1.5",
    createServer: handles.createServer,
  });
  const endpoints = await controller.acquire();
  assert.equal(endpoints.embedded, true);
  assert.equal(endpoints.wsUrl, "ws://127.0.0.1:37844/ws");
  assert.equal(endpoints.pageBaseUrl, "http://192.168.1.5:37844/remote/v4");
  await controller.dispose();
});

test("refcount：两次 acquire 只启动一次，两次 release 后才关停", async () => {
  const handles = createFakeServerHandles();
  const controller = createEmbeddedRelayController({
    logger: createLogger(),
    env: {},
    resolveLanHost: async () => "10.0.0.7",
    createServer: handles.createServer,
  });
  await controller.acquire();
  await controller.acquire();
  assert.equal(handles.servers.length, 1);
  await controller.release();
  assert.equal(handles.servers[0].closeCount, 0);
  await controller.release();
  assert.equal(handles.servers[0].closeCount, 1);
});

test("release 归零后再次 acquire 重启服务", async () => {
  const handles = createFakeServerHandles();
  const controller = createEmbeddedRelayController({
    logger: createLogger(),
    env: {},
    resolveLanHost: async () => "10.0.0.7",
    createServer: handles.createServer,
  });
  await controller.acquire();
  await controller.release();
  const endpoints = await controller.acquire();
  assert.equal(endpoints.wsUrl, "ws://127.0.0.1:37843/ws");
  assert.equal(handles.servers.length, 2);
  await controller.dispose();
});

test("外部模式：relay WS env 已设时不启动内嵌服务，release 无副作用", async () => {
  const handles = createFakeServerHandles();
  const controller = createEmbeddedRelayController({
    logger: createLogger(),
    env: { ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL: "ws://relay.example.com/ws" },
    resolveLanHost: async () => "192.168.1.5",
    createServer: handles.createServer,
  });
  const endpoints = await controller.acquire();
  assert.equal(endpoints.embedded, false);
  assert.equal(endpoints.wsUrl, "ws://relay.example.com/ws");
  assert.equal(handles.servers.length, 0);
  await controller.release();
  assert.equal(handles.servers.length, 0);
});

test("页基址 env 覆盖：ZCODE_WEB_REMOTE_CONTROL_URL 优先于 LAN 地址（内嵌服务仍启动承载 WS）", async () => {
  const handles = createFakeServerHandles();
  const controller = createEmbeddedRelayController({
    logger: createLogger(),
    env: { ZCODE_WEB_REMOTE_CONTROL_URL: "https://pages.example.com/remote/v4" },
    resolveLanHost: async () => "192.168.1.5",
    createServer: handles.createServer,
  });
  const endpoints = await controller.acquire();
  assert.equal(endpoints.embedded, true);
  assert.equal(endpoints.wsUrl, "ws://127.0.0.1:37843/ws");
  assert.equal(endpoints.pageBaseUrl, "https://pages.example.com/remote/v4");
  await controller.dispose();
});

test("全部候选端口失败：acquire 抛错并回滚计数；恢复后允许重试", async () => {
  const handles = createFakeServerHandles();
  handles.state.failAllPorts = true;
  const controller = createEmbeddedRelayController({
    logger: createLogger(),
    env: {},
    resolveLanHost: async () => "192.168.1.5",
    createServer: handles.createServer,
  });
  await assert.rejects(() => controller.acquire(), /内嵌 relay 启动失败/);
  // 失败回滚：一次 acquire + release 不应遗留计数（关停调用数为 0 说明没有泄漏会话）。
  handles.state.failAllPorts = false;
  const endpoints = await controller.acquire();
  assert.equal(endpoints.wsUrl, "ws://127.0.0.1:37843/ws");
  await controller.release();
  assert.equal(handles.servers[handles.servers.length - 1].closeCount, 1);
});

test("无 LAN IPv4 时页基址回落回环（仅本机可达）", async () => {
  const handles = createFakeServerHandles();
  const controller = createEmbeddedRelayController({
    logger: createLogger(),
    env: {},
    resolveLanHost: async () => null,
    lanEnumerationFallback: () => null,
    createServer: handles.createServer,
  });
  const endpoints = await controller.acquire();
  assert.equal(endpoints.pageBaseUrl, "http://127.0.0.1:37843/remote/v4");
  await controller.dispose();
});

test("peek：未运行返回 null；运行中同 acquire 端点且不占计数；外部模式返回外部地址", async () => {
  const handles = createFakeServerHandles();
  const controller = createEmbeddedRelayController({
    logger: createLogger(),
    env: {},
    resolveLanHost: async () => "192.168.1.5",
    createServer: handles.createServer,
  });
  assert.equal(await controller.peek(), null);
  const endpoints = await controller.acquire();
  const peeked = await controller.peek();
  assert.deepEqual(peeked, endpoints);
  await controller.release();
  assert.equal(await controller.peek(), null);

  const external = createEmbeddedRelayController({
    logger: createLogger(),
    env: { ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL: "ws://relay.example.com/ws" },
    resolveLanHost: async () => "192.168.1.5",
    createServer: handles.createServer,
  });
  const externalPeek = await external.peek();
  assert.equal(externalPeek?.embedded, false);
  assert.equal(externalPeek?.wsUrl, "ws://relay.example.com/ws");
});

test("注入解析（钉选）优先，且每次 acquire 重新解析（钉选热切换生效）", async () => {
  const handles = createFakeServerHandles();
  let pinned = "";
  const controller = createEmbeddedRelayController({
    logger: createLogger(),
    env: {},
    resolveLanHost: async () => pinned || null,
    lanEnumerationFallback: () => null,
    createServer: handles.createServer,
  });
  const first = await controller.acquire();
  assert.equal(first.pageBaseUrl, "http://127.0.0.1:37843/remote/v4");
  pinned = "10.1.2.3";
  const second = await controller.acquire();
  assert.equal(second.pageBaseUrl, "http://10.1.2.3:37843/remote/v4");
  assert.equal(second.wsUrl, "ws://127.0.0.1:37843/ws");
  await controller.dispose();
});

test("设置键外部模式（resolveExternalEndpoints 钩子）：不启动内嵌服务；env 优先于钩子", async () => {
  const handles = createFakeServerHandles();
  const settingsExternal = createEmbeddedRelayController({
    logger: createLogger(),
    env: {},
    resolveExternalEndpoints: async () => ({
      wsUrl: "https://my-relay.example.com/ws",
      pageBaseUrl: "https://my-relay.example.com/remote/v4",
      embedded: false,
    }),
    resolveLanHost: async () => "192.168.1.5",
    createServer: handles.createServer,
  });
  const endpoints = await settingsExternal.acquire();
  assert.equal(endpoints.embedded, false);
  assert.equal(endpoints.wsUrl, "https://my-relay.example.com/ws");
  assert.equal(handles.servers.length, 0);
  const peeked = await settingsExternal.peek();
  assert.equal(peeked?.pageBaseUrl, "https://my-relay.example.com/remote/v4");
  await settingsExternal.release();

  const envWins = createEmbeddedRelayController({
    logger: createLogger(),
    env: { ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL: "ws://env-relay.example.com/ws" },
    resolveExternalEndpoints: async () => ({
      wsUrl: "https://settings-relay.example.com/ws",
      pageBaseUrl: "https://settings-relay.example.com/remote/v4",
      embedded: false,
    }),
    createServer: handles.createServer,
  });
  const envEndpoints = await envWins.acquire();
  assert.equal(envEndpoints.wsUrl, "ws://env-relay.example.com/ws");
  await envWins.release();

  const hookNullFallsBackEmbedded = createEmbeddedRelayController({
    logger: createLogger(),
    env: {},
    resolveExternalEndpoints: async () => null,
    resolveLanHost: async () => "192.168.1.5",
    createServer: handles.createServer,
  });
  const embedded = await hookNullFallsBackEmbedded.acquire();
  assert.equal(embedded.embedded, true);
  await hookNullFallsBackEmbedded.dispose();
});
