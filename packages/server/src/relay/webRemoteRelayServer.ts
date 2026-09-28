import { randomBytes, randomUUID } from "node:crypto";
import { serve, type ServerType } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WebSocket } from "ws";
import type { WSContext } from "hono/ws";
import {
  relayOutboundFrameSchema,
  type RelayErrorCode,
  type RelayOutboundFrame,
} from "@zcode/shared/web-remote-control";
import { verifyRelayAuthProof } from "@zcode/shared/web-remote-control/auth-node";
import { createMobileSession } from "./mobilePage.js";
import { registerMobilePageRoutes } from "./mobilePageBundle.js";
import { PairingTable, type RelayConn, type RelayRole } from "./pairingTable.js";
import {
  applyKicks,
  forwardData,
  parseTextFrame,
  pushPairStatus,
  rejectConnection,
  sendToDevice,
  toSession,
  type RelayLogLevel,
  type RelayLogger,
  type RelaySession,
  type RelaySessionDeps,
  type RelayStats,
} from "./relayProtocol.js";

// 自建薄 relay 服务端（对齐官方 3.14.3 relay 职责边界：注册/鉴权/单终端配对/心跳应答/
// data 转发/KICKED，不存任何业务状态）。WS 端点 /ws，手机页端点 /remote/v4。

// ---------- 最小 logger（不使用 console；debug 默认不落盘）与 debug 计数 ----------

const LOG_LEVEL_ORDER: Record<RelayLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export function createRelayLogger(
  options: { level?: RelayLogLevel; scope?: string; write?: (line: string) => void } = {},
): RelayLogger {
  const level = options.level ?? "info";
  const scope = options.scope ?? "web-remote-relay";
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (
    severity: RelayLogLevel,
    message: string,
    detail?: Record<string, unknown>,
  ): void => {
    if (LOG_LEVEL_ORDER[severity] < LOG_LEVEL_ORDER[level]) return;
    const suffix = detail && Object.keys(detail).length > 0 ? ` ${JSON.stringify(detail)}` : "";
    write(`[${scope}] ${new Date().toISOString()} ${severity} ${message}${suffix}`);
  };
  return {
    debug: (message, detail) => emit("debug", message, detail),
    info: (message, detail) => emit("info", message, detail),
    warn: (message, detail) => emit("warn", message, detail),
    error: (message, detail) => emit("error", message, detail),
  };
}

export function createRelayStats(): RelayStats {
  return {
    oversizeFramesDropped: 0,
    binaryFramesDropped: 0,
    invalidFramesDropped: 0,
    unpairedDeviceDataDropped: 0,
    unpairedMobileDataDropped: 0,
    forwardedData: 0,
  };
}

export interface WebRemoteRelayServerOptions {
  /** 默认 127.0.0.1（与 @zcode/shared/web-remote-control 的默认端点一致）。 */
  host?: string;
  /** 默认 37843（defaultRelayWsUrl / defaultRemotePageUrl 的端口）。 */
  port?: number;
  logger?: RelayLogger;
  /** 日志级别（未传 logger 时生效）；debug 仅诊断用，生产默认 info。 */
  logLevel?: "debug" | "info" | "warn" | "error" | "silent";
  /** 移动页 bundle 目录（缺省 ZCODE_WEB_REMOTE_MOBILE_PAGE_DIR 或 packages/web/dist-mobile）。 */
  mobilePageDir?: string;
  /** dev 转发目标（缺省 ZCODE_WEB_REMOTE_MOBILE_PAGE_PROXY；dev 服务器需 --base /remote/v4/）。 */
  mobilePageProxyOrigin?: string;
}

export interface WebRemoteRelayServer {
  readonly server: ServerType;
  readonly table: PairingTable;
  stats(): RelayStats;
  /** 优雅关闭：断开全部 WS 连接后关闭 HTTP 服务。 */
  close(): Promise<void>;
}

interface ConnectionContext {
  conn: RelayConn;
  session: RelaySession;
}

function trimParam(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function wrapWs(ws: WSContext<WebSocket>, role: RelayRole): RelayConn {
  return {
    connId: randomUUID(),
    role,
    sendText(text: string): boolean {
      if (ws.readyState !== 1) return false;
      ws.send(text);
      return true;
    },
    close(code: number, reason: string): void {
      ws.close(code, reason);
    },
  };
}

function resolveRole(creds: {
  sid?: string;
  hash?: string;
  mid?: string;
  headerMid?: string;
}): RelayRole | null {
  const hasMobileCreds = Boolean(creds.sid && creds.hash);
  const hasDeviceCreds = Boolean(creds.mid || creds.headerMid);
  // 手机端：带 sid&hash 查询参数；设备端：?mid= 或头 X-Device-ID。二者皆带/皆缺 → 拒绝。
  if (hasMobileCreds === hasDeviceCreds) return null;
  return hasMobileCreds ? "mobile" : "device";
}

/** 设备（桌面）会话：register → challenge-response auth → 心跳/data。 */
export function createDeviceSession(conn: RelayConn, deps: RelaySessionDeps): RelaySession {
  const { table, logger, stats } = deps;
  let phase: "open" | "challenge" | "ready" | "closed" = "open";
  let sessionSid = "";
  let registeredSid = "";
  let nonce = "";

  const fail = (code: RelayErrorCode, message: string): void => {
    if (phase === "closed") return;
    phase = "closed";
    logger.warn("device session closed", { connId: conn.connId, code, message });
    rejectConnection(conn, code, message, logger);
  };

  const handleFrame = (frame: RelayOutboundFrame): void => {
    switch (frame.type) {
      case "device_register_init": {
        if (phase === "challenge" || phase === "closed") {
          fail("WRONG_PARAM", "unexpected device_register_init");
          return;
        }
        const result = table.registerDevice(
          { deviceMid: frame.device_mid, passHash: frame.pass_hash, meta: frame.meta },
          conn,
        );
        if (phase === "ready" && result.entry.deviceSid !== sessionSid) {
          fail("WRONG_PARAM", "device_sid changed after auth");
          return;
        }
        registeredSid = result.entry.deviceSid;
        // 先应答本端 register_ack，再处理踢旧与推送，保证同一连接上的帧序可预期。
        sendToDevice(
          conn,
          { type: "device_register_ack", device_sid: result.entry.deviceSid },
          logger,
        );
        applyKicks(result.kicked, logger);
        if (result.passHashRotated) pushPairStatus(result.entry, logger);
        logger.info("device registered", {
          connId: conn.connId,
          deviceSid: result.entry.deviceSid,
          reused: !result.created,
          rotated: result.passHashRotated,
        });
        return;
      }
      case "auth_init": {
        if (phase !== "open") {
          fail("WRONG_PARAM", "unexpected auth_init");
          return;
        }
        if (!table.findBySid(frame.device_sid)) {
          fail("AUTH_FAILED", "session-not-found");
          return;
        }
        if (registeredSid && registeredSid !== frame.device_sid) {
          fail("WRONG_PARAM", "device_sid mismatch");
          return;
        }
        sessionSid = frame.device_sid;
        nonce = randomBytes(24).toString("base64url");
        phase = "challenge";
        sendToDevice(conn, { type: "auth_challenge", nonce }, logger);
        return;
      }
      case "auth_response": {
        if (phase !== "challenge" || frame.device_sid !== sessionSid) {
          fail("WRONG_PARAM", "unexpected auth_response");
          return;
        }
        const entry = table.findBySid(sessionSid);
        const proof = verifyRelayAuthProof(entry?.passHash ?? "", nonce, sessionSid, frame.proof);
        nonce = "";
        if (!entry || !proof) {
          fail("AUTH_FAILED", entry ? "invalid proof" : "session-not-found");
          return;
        }
        const attached = table.attachDevice(sessionSid, conn);
        if (!attached) {
          fail("AUTH_FAILED", "session-not-found");
          return;
        }
        phase = "ready";
        // 先应答本端 auth_ack，再踢旧设备，保证同一连接上的帧序可预期。
        sendToDevice(conn, { type: "auth_ack", pair_status: attached.entry.pairStatus }, logger);
        applyKicks(attached.kicked, logger);
        logger.info("device authenticated", { connId: conn.connId, deviceSid: sessionSid });
        return;
      }
      case "pair_status_query": {
        if (phase !== "ready" || frame.device_sid !== sessionSid) {
          fail("WRONG_PARAM", "unexpected pair_status_query");
          return;
        }
        const entry = table.findBySid(sessionSid);
        if (!entry) {
          fail("AUTH_FAILED", "session-not-found");
          return;
        }
        sendToDevice(conn, { type: "pair_status_ack", pair_status: entry.pairStatus }, logger);
        return;
      }
      case "data": {
        if (phase !== "ready") {
          fail("WRONG_PARAM", "unexpected data");
          return;
        }
        forwardData(conn, frame, deps);
        return;
      }
    }
  };

  const handleText = (text: string): void => {
    const parsed = parseTextFrame(text, conn, deps);
    if (!parsed.ok) {
      if (parsed.reason === "bad-json") fail("WRONG_PARAM", "invalid json");
      return;
    }
    const frame = relayOutboundFrameSchema.safeParse(parsed.value);
    if (!frame.success) {
      stats.invalidFramesDropped += 1;
      fail("WRONG_PARAM", "invalid device frame");
      return;
    }
    handleFrame(frame.data);
  };

  return toSession(conn, deps, () => phase === "closed", handleText);
}

export function createWebRemoteRelayServer(
  options: WebRemoteRelayServerOptions = {},
): WebRemoteRelayServer {
  const host = options.host?.trim() || "127.0.0.1";
  const port = options.port ?? 37843;
  const logger = options.logger ?? createRelayLogger({ level: options.logLevel ?? "info" });
  const stats = createRelayStats();
  const table = new PairingTable();
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const connections = new Map<WSContext<WebSocket>, ConnectionContext>();

  // /remote/v4 移动页：dev 转发 → bundle 静态服务（注入 __RELAY_CONFIG__）→ 内嵌最小页 fallback。
  registerMobilePageRoutes(app, {
    ...(options.mobilePageDir ? { mobilePageDir: options.mobilePageDir } : {}),
    ...(options.mobilePageProxyOrigin
      ? { mobilePageProxyOrigin: options.mobilePageProxyOrigin }
      : {}),
  });

  app.get(
    "/ws",
    upgradeWebSocket(
      (c) => {
        const url = new URL(c.req.url);
        const creds = {
          sid: trimParam(url.searchParams.get("sid")),
          hash: trimParam(url.searchParams.get("hash")),
          mid: trimParam(url.searchParams.get("mid")),
          headerMid: trimParam(c.req.header("x-device-id")),
        };
        return {
          onOpen(_event, ws) {
            const role = resolveRole(creds);
            const conn = wrapWs(ws, role ?? "device");
            if (!role) {
              rejectConnection(
                conn,
                "WRONG_PARAM",
                "missing or ambiguous connection params",
                logger,
              );
              return;
            }
            if (creds.mid && creds.headerMid && creds.mid !== creds.headerMid) {
              rejectConnection(conn, "WRONG_PARAM", "X-Device-ID mismatch", logger);
              return;
            }
            const deps = { table, logger, stats };
            const session =
              role === "mobile"
                ? createMobileSession(conn, deps, { sid: creds.sid, hash: creds.hash })
                : createDeviceSession(conn, deps);
            connections.set(ws, { conn, session });
            logger.debug("ws connected", { connId: conn.connId, role });
          },
          onMessage(event, ws) {
            connections.get(ws)?.session.handleMessage(event.data);
          },
          onClose(_event, ws) {
            const context = connections.get(ws);
            connections.delete(ws);
            context?.session.dispose();
          },
          onError(_event, ws) {
            const context = connections.get(ws);
            connections.delete(ws);
            context?.session.dispose();
          },
        };
      },
      { onError: (error: unknown) => logger.error("ws handler error", { error: String(error) }) },
    ),
  );

  const server = serve({ fetch: app.fetch, hostname: host, port }, () => {
    logger.info(`relay listening on http://${host}:${port} (ws /ws, page /remote/v4)`);
  });
  injectWebSocket(server);

  return {
    server,
    table,
    stats: () => ({ ...stats }),
    async close(): Promise<void> {
      for (const ws of connections.keys()) {
        try {
          ws.close(1001, "server shutting down");
        } catch {
          // 连接已断开时忽略
        }
      }
      for (const context of connections.values()) {
        context.session.dispose();
      }
      connections.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        if ("closeAllConnections" in server) {
          server.closeAllConnections();
        }
      });
    },
  };
}
