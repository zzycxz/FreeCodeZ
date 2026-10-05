import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono, type Context, type Next } from "hono";
import type { WebSocket } from "ws";
import type { WebSocketServer } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  LoggingChannelServer,
  type ISocket,
} from "@zcode/rpc";
import {
  createZCodeAgentConnectionScope,
  IZCodeAgentService,
  ServiceCollection,
} from "@zcode/services";
import { createServiceLogger } from "@zcode/services/node";
import {
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_VERSION,
  type ServerRemoteInfo,
} from "@zcode/shared";
import { createHostCapabilityStore, type HostCapabilityStore } from "./hostCapability.js";

interface CoreHttpServer {
  host: string;
  port: number;
  close: () => Promise<void>;
}

const WEBSOCKET_DRAIN_TIMEOUT_MS = 250;
const log = createServiceLogger("server-core");

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    // HTTP server.close() 不会收敛已经 upgrade 的 WebSocket，活跃 desktop
    // continuous 连接会让 Core 的 shutdown ack 永远发不出去。先发 close frame 给正常
    // 客户端一个短暂排空窗口，再 terminate 兜底，保证 Supervisor 能在预算内释放资源。
    client.close(1001, "Server shutting down");
  }
  const deadline = Date.now() + WEBSOCKET_DRAIN_TIMEOUT_MS;
  while (wss.clients.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve, reject) => {
    wss.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function wrapWebSocket(ws: WebSocket): ISocket {
  const data = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  ws.on("message", (raw) =>
    data.fire(VSBuffer.wrap(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer))),
  );
  ws.on("close", () => close.fire());
  ws.on("error", () => close.fire());
  return {
    onData: data.event,
    onClose: close.event,
    onEnd: close.event,
    write(buffer) {
      if (ws.readyState === ws.OPEN) ws.send(buffer.buffer);
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

function exposeWebSocket(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
): void {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  const server = new LoggingChannelServer(rawServer, (...args) => log.debug(undefined, ...args));
  const agentService = services.getOptional(IZCodeAgentService);
  const scope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `server-core-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  services.exposeOnChannelServer(
    server,
    scope ? new Map([[IZCodeAgentService.channelName, scope.service]]) : new Map(),
  );
  socket.onClose(() => {
    void scope?.dispose();
    rawServer.dispose();
  });
}

export async function createCoreHttpServer(
  services: ServiceCollection,
  options: {
    host?: string;
    port?: number;
    serverId?: string;
    hostCapabilityStore?: HostCapabilityStore;
    /**
     * 0-6（升级实施手册）：访问 token（测试注入口；缺省读 ZCODE_SERVER_TOKEN，与 lite
     * server P2 §4.11 同键同语义）。设置后 /ws 与 capability 发放口需要 token；
     * 未设置时回环绑定保持现状（非回环绑定仍被上方守卫 fail-closed 拒绝）。
     */
    authToken?: string;
  } = {},
): Promise<CoreHttpServer> {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    // 非回环绑定必须显式 token；未配置即 fail-closed 拒绝监听。
    throw new Error(
      `Non-loopback host ${host} requires authentication before the server can listen`,
    );
  }
  const authToken = (options.authToken ?? process.env.ZCODE_SERVER_TOKEN ?? "").trim() || undefined;
  const info: ServerRemoteInfo = {
    serverId: options.serverId ?? hostname() ?? "zcode-server",
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: Boolean(authToken),
    workspaces: [],
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      processResourceTelemetry: true,
    },
  };
  // 裸 Set 无法落实 expiresAt，未消费的 capability 会一直有效并持续累积。
  // 使用与 packages/server 兼容的 TTL 一次性 store，使有效期和消费语义与返回信息一致。
  const capabilities = options.hostCapabilityStore ?? createHostCapabilityStore();
  // 0-6（升级实施手册）：/ws 零鉴权 + capability 发放口不设门——任何本地进程都能直连
  // agent RPC 或凭空铸造 host capability（拿到即 trusted-host-relay 全权）。设置 token 后
  // 两处同守卫；Bearer 头供程序客户端，?token= 供浏览器 WS（本服务无静态面，不需要 cookie 面）。
  if (authToken) {
    const requireToken = async (context: Context, next: Next) => {
      const authorization = context.req.header("authorization");
      if (
        (authorization?.startsWith("Bearer ") &&
          authorization.slice(7).trim() === authToken) ||
        context.req.query("token") === authToken
      ) {
        await next();
        return;
      }
      return context.json({ error: "Missing or invalid server token" }, 401);
    };
    app.use("/ws", requireToken);
    app.use("/api/rpc-host-capability", requireToken);
  }
  app.get("/api/server-info", (context) => context.json(info));
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        exposeWebSocket(socket.raw as WebSocket, services, "web-remote-replayable");
      },
    })),
  );
  app.use("/ws/host", async (context, next) => {
    const capability = context.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
    if (!capabilities.consume(capability)) {
      return context.json({ error: "Invalid or expired host capability" }, 401);
    }
    await next();
  });
  app.get(
    "/ws/host",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        exposeWebSocket(socket.raw as WebSocket, services, "desktop-continuous");
      },
    })),
  );
  app.post("/api/rpc-host-capability", (context) => context.json(capabilities.issue()));
  let resolveListening: (value: { port: number }) => void = () => undefined;
  const listening = new Promise<{ port: number }>((resolve) => {
    resolveListening = resolve;
  });
  const server = serve({ fetch: app.fetch, hostname: host, port: options.port ?? 0 }, () => {
    const address = server.address();
    resolveListening({
      port: typeof address === "object" && address ? address.port : (options.port ?? 0),
    });
  });
  injectWebSocket(server);
  const { port } = await listening;
  return {
    host,
    port,
    close: async () => {
      await closeWebSocketServer(wss);
      await new Promise<void>((resolve, reject) =>
        server.close((error?: Error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
