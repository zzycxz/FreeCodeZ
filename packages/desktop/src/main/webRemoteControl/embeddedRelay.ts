import { networkInterfaces } from "node:os";
import {
  WEB_REMOTE_CONTROL_ENDPOINTS,
  buildEmbeddedRelayEndpoints,
  embeddedRelayPortCandidates,
  pickLanIPv4,
  resolveRemotePageUrl,
  resolveRelayWsUrl,
} from "@zcode/shared/web-remote-control";
import type { WebRemoteRelayServer } from "@zcode/server/relay";

// 内嵌 LAN relay 控制器（spec §5 开箱拓扑）：任一窗口 Manager start 时懒启动，
// 全部会话 teardown 后关闭。外部模式（ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL 已设）
// 直接返回外部端点且不占 refcount。本模块保持 electron 无关（路径解析由组装层注入）。

export interface EmbeddedRelayEndpoints {
  /** 桌面 transport 的 WS 地址（内嵌模式恒回环）。 */
  wsUrl: string;
  /** 手机配对页基址（内嵌模式=LAN IPv4；被 ZCODE_WEB_REMOTE_CONTROL_URL 覆盖）。 */
  pageBaseUrl: string;
  /** 内嵌模式为真；外部模式为假（release 无副作用）。 */
  embedded: boolean;
}

/** 与 server relay 的 RelayLogger 结构等价（避免引入未导出的内部类型路径）。 */
export type EmbeddedRelayServerLogger = {
  debug(message: string, detail?: Record<string, unknown>): void;
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
  error(message: string, detail?: Record<string, unknown>): void;
};

export interface EmbeddedRelayControllerDeps {
  logger: {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  env?: Record<string, string | undefined>;
  /** 手机页 bundle 目录（组装层解析；不存在时 relay 回退内置最小页）。 */
  mobilePageDir?: string;
  /**
   * LAN 主机解析（spec §5：钉选 > 默认路由出口；注入方组装）。
   * 返回 null = 无可用 LAN 地址（回落网卡枚举排序，再回落回环）。
   */
  resolveLanHost?: () => Promise<string | null>;
  /** 网卡枚举回退（默认真机 pickLanIPv4；测试注入以保持确定性）。 */
  lanEnumerationFallback?: () => string | null;
  /**
   * 外部自建中继端点（spec §1.11）：返回非 null 即外部模式（不启动内嵌服务）。
   * 优先级：env ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL > 此钩子（settings URL）> 内嵌。
   */
  resolveExternalEndpoints?: () => Promise<EmbeddedRelayEndpoints | null>;
  createServer: (options: {
    host: string;
    port: number;
    mobilePageDir?: string;
    logger: EmbeddedRelayServerLogger;
  }) => Promise<WebRemoteRelayServer>;
}

export interface EmbeddedRelayController {
  acquire(): Promise<EmbeddedRelayEndpoints>;
  release(): Promise<void>;
  /** 只读端点（不占计数；未运行返回 null；外部模式返回外部地址）。 */
  peek(): Promise<EmbeddedRelayEndpoints | null>;
  /** app 退出兜底：无论 refcount 直接关停。 */
  dispose(): Promise<void>;
}

function toRelayLogger(logger: EmbeddedRelayControllerDeps["logger"]): EmbeddedRelayServerLogger {
  return {
    debug: (message, detail) => logger.debug(message, detail),
    info: (message, detail) => logger.info(message, detail),
    warn: (message, detail) => logger.warn(message, detail),
    error: (message, detail) => logger.error(message, detail),
  };
}

function listenOnce(server: WebRemoteRelayServer): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    server.server.once("error", (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    server.server.once("listening", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });
}

export function createEmbeddedRelayController(
  deps: EmbeddedRelayControllerDeps,
): EmbeddedRelayController {
  const env = deps.env ?? process.env;
  const pageBaseUrlEnv = env[WEB_REMOTE_CONTROL_ENDPOINTS.remotePageUrlEnv]?.trim();

  let refCount = 0;
  let running: { server: WebRemoteRelayServer; port: number } | null = null;
  let startPromise: Promise<number> | null = null;
  let closingPromise: Promise<void> | null = null;

  /** LAN 主机：注入解析（钉选>默认路由出口）> 网卡枚举排序 > 回环。 */
  async function resolveLanHost(): Promise<string> {
    const injected = (await deps.resolveLanHost?.()) ?? null;
    if (injected?.trim()) return injected.trim();
    // 注入的枚举回退返回 null 即"无枚举结果"，直接落回环；不能用 ?? 链（null 会再触发真机枚举）。
    const fallback = deps.lanEnumerationFallback
      ? deps.lanEnumerationFallback()
      : pickLanIPv4(Object.values(networkInterfaces()).map((list) => list ?? []));
    return fallback ?? "127.0.0.1";
  }

  /** 外部模式判定（spec §1.11）：env > 注入钩子（settings URL）> null=内嵌。 */
  async function resolveExternalMode(): Promise<EmbeddedRelayEndpoints | null> {
    if (env[WEB_REMOTE_CONTROL_ENDPOINTS.relayWsUrlEnv]?.trim()) {
      return { wsUrl: resolveRelayWsUrl(env), pageBaseUrl: resolveRemotePageUrl(env), embedded: false };
    }
    return deps.resolveExternalEndpoints?.() ?? null;
  }

  async function buildEndpoints(port: number): Promise<EmbeddedRelayEndpoints> {
    const lanHost = await resolveLanHost();
    const endpoints = buildEmbeddedRelayEndpoints({ port, lanHost });
    return {
      wsUrl: endpoints.wsUrl,
      pageBaseUrl: pageBaseUrlEnv ? resolveRemotePageUrl(env) : endpoints.pageBaseUrl,
      embedded: true,
    };
  }

  async function startEmbedded(): Promise<number> {
    const candidates = embeddedRelayPortCandidates();
    let lastError: unknown = null;
    for (const port of candidates) {
      let server: WebRemoteRelayServer;
      try {
        server = await deps.createServer({
          host: "0.0.0.0",
          port,
          ...(deps.mobilePageDir ? { mobilePageDir: deps.mobilePageDir } : {}),
          logger: toRelayLogger(deps.logger),
        });
        await listenOnce(server);
      } catch (error) {
        lastError = error;
        deps.logger.warn("[web-remote-embedded-relay] port unavailable, trying next", {
          port,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      deps.logger.info("[web-remote-embedded-relay] listening", { port });
      running = { server, port };
      return port;
    }
    throw new Error(
      `内嵌 relay 启动失败：端口 ${candidates[0]}-${candidates[candidates.length - 1]} 均不可用（${
        lastError instanceof Error ? lastError.message : String(lastError)
      }）`,
    );
  }

  return {
    async acquire(): Promise<EmbeddedRelayEndpoints> {
      // 外部模式：env 或设置键指定自建中继，不启动内嵌服务（spec §1.11 覆盖优先）。
      const external = await resolveExternalMode();
      if (external) {
        return external;
      }
      refCount += 1;
      try {
        if (!running) {
          if (closingPromise) {
            await closingPromise;
            closingPromise = null;
          }
          if (!running) {
            // finally 清引用：失败后下一次 acquire 允许重试；并发 acquire 共享同一次启动。
            const attempt = (startPromise ??= startEmbedded().finally(() => {
              startPromise = null;
            }));
            await attempt;
          }
        }
        if (!running) {
          // 不变量守卫：startEmbedded 成功必置 running；防御未来重构破坏该约定。
          throw new Error("embedded relay started but no server is running");
        }
        return buildEndpoints(running.port);
      } catch (error) {
        // 启动失败回退本次计数，避免计数泄漏导致 relay 永不关闭。
        refCount = Math.max(0, refCount - 1);
        throw error;
      }
    },

    async peek(): Promise<EmbeddedRelayEndpoints | null> {
      const external = await resolveExternalMode();
      if (external) {
        return external;
      }
      if (!running) return null;
      return buildEndpoints(running.port);
    },

    async release(): Promise<void> {
      refCount = Math.max(0, refCount - 1);
      if (refCount > 0 || !running) return;
      const current = running;
      running = null;
      closingPromise = (async () => {
        try {
          await current.server.close();
          deps.logger.info("[web-remote-embedded-relay] closed", { port: current.port });
        } catch (error) {
          deps.logger.warn("[web-remote-embedded-relay] close failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      await closingPromise;
      closingPromise = null;
    },

    async dispose(): Promise<void> {
      refCount = 0;
      const current = running;
      running = null;
      if (current) await current.server.close().catch(() => undefined);
    },
  };
}
