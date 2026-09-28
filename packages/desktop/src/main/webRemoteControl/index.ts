import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createWebRemoteRelayServer } from "@zcode/server/relay";
import { PlatformChannels, type RemoteTarget } from "@zcode/shared";
import { app } from "electron";
import {
  createWebRemoteControlManager,
  type WebRemoteControlManager,
  type WebRemoteControlManagerLogger,
} from "./manager.js";
import {
  createWebRemoteControlHostAttachments,
  type WebRemoteControlHostAttachments,
} from "./hostAttachments.js";
import { createRelayPairingStore, type RelayPairingStore } from "./pairing.js";
import { createEmbeddedRelayController, type EmbeddedRelayController } from "./embeddedRelay.js";
import { listPairNics, resolveDefaultLanHost } from "./lanAddress.js";
import {
  createRendererReconnectBridge,
  findWindowByWebContentsId,
  registerWebRemoteControlIpc,
  type WebRemoteControlIpcLogger,
} from "./webRemoteControlIpc.js";
import type { WebRemoteControlPlatformHandlers } from "./appMessageRouter.js";

// 移动端远控 desktop main 子系统组装：per-webContents 的 Manager 注册表、凭据/设置持久化、
// Host attachment 借用、IPC 注册与「全局一次性 + 首个匹配窗口独占」的重启恢复。
// 内嵌 LAN relay（spec §5）为 app 级单例：任一 Manager start 懒启动，refcount 归零关停。

export interface WebRemoteControlSubsystemOptions {
  logger: WebRemoteControlManagerLogger & WebRemoteControlIpcLogger;
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  attachRemoteWorkspaceSessionHost: (params: {
    windowId: number;
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspaceKey: string;
    clientMode: "web-remote-replayable";
  }) => {
    process: ElectronUtilityProcess;
    port: import("electron").MessagePortMain;
    remoteKind: RemoteTarget["kind"];
  };
  settingService: Parameters<typeof createRelayPairingStore>[0]["settingService"];
  credentialService: Parameters<typeof createRelayPairingStore>[0]["credentialService"];
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  platformHandlers: WebRemoteControlPlatformHandlers;
  resolveWsUrl?: () => string;
}

export interface WebRemoteControlSubsystem {
  registerIpc(): void;
  handleWindowClosed(webContentsId: number): Promise<void>;
  disposeAll(): Promise<void>;
}

/** 手机页 bundle 目录：打包态=resources/web-remote-mobile；dev 态=仓库 packages/web/dist-mobile（可缺省，relay 回退内置页）。 */
function resolveEmbeddedMobilePageDir(): string | undefined {
  if (app.isPackaged) {
    return join(process.resourcesPath, "web-remote-mobile");
  }
  const devDir = join(app.getAppPath(), "..", "..", "packages", "web", "dist-mobile");
  return existsSync(devDir) ? devDir : undefined;
}

export function createWebRemoteControlSubsystem(
  options: WebRemoteControlSubsystemOptions,
): WebRemoteControlSubsystem {
  const pairing: RelayPairingStore = createRelayPairingStore({
    credentialService: options.credentialService,
    settingService: options.settingService,
    logger: options.logger,
  });
  const hostAttachments: WebRemoteControlHostAttachments = createWebRemoteControlHostAttachments({
    windowHostProcessMap: options.windowHostProcessMap,
    attachRemoteWorkspaceSessionHost: options.attachRemoteWorkspaceSessionHost,
    logger: options.logger,
  });
  const reconnectBridge = createRendererReconnectBridge(options.logger);
  // LAN 主机解析（spec §5）：设置钉选 > 默认路由出口（fairpeer 同法）。
  const resolveLanHost = async (): Promise<string | null> => {
    try {
      const settings = await options.settingService.get();
      const pinned = settings.webRemoteControlPairAddress?.trim();
      if (pinned) return pinned;
    } catch (error) {
      options.logger.warn("[web-remote-control] read pinned pair address failed", error);
    }
    return (await resolveDefaultLanHost())?.ip ?? null;
  };
  // 外部自建中继（spec §1.11 开放能力）：设置键 origin → ws=origin+/ws、手机页=origin+/remote/v4。
  const resolveExternalEndpoints = async (): Promise<{
    wsUrl: string;
    pageBaseUrl: string;
    embedded: false;
  } | null> => {
    const origin = await pairing.readExternalRelayUrl();
    if (!origin) return null;
    const normalized = origin.replace(/\/+$/, "");
    return {
      wsUrl: `${normalized}/ws`,
      pageBaseUrl: `${normalized}/remote/v4`,
      embedded: false,
    };
  };
  const embeddedRelay: EmbeddedRelayController = createEmbeddedRelayController({
    logger: options.logger,
    ...(resolveEmbeddedMobilePageDir()
      ? { mobilePageDir: resolveEmbeddedMobilePageDir() }
      : {}),
    resolveLanHost,
    resolveExternalEndpoints,
    createServer: async (serverOptions) => createWebRemoteRelayServer(serverOptions),
  });
  const managers = new Map<number, WebRemoteControlManager>();
  // 重启恢复 + 常驻可达：全局一次性标志 + 首个匹配窗口独占（官方同款语义）。
  let restoreConsumed = false;

  function getManager(webContentsId: number): WebRemoteControlManager {
    const existing = managers.get(webContentsId);
    if (existing) return existing;
    const manager = createWebRemoteControlManager({
      webContentsId,
      logger: options.logger,
      pairing,
      hostAttachments,
      deviceMid: options.deviceMid,
      deviceName: options.deviceName,
      appVersion: options.appVersion,
      platformHandlers: options.platformHandlers,
      requestWorkspaceReconnect: (requestId, workspaceKey) =>
        reconnectBridge.request(webContentsId, requestId, workspaceKey),
      sendStatus: (status) => {
        const win = findWindowByWebContentsId(webContentsId);
        if (!win) return;
        // 状态唯一写入方是 Manager；renderer 只读投影经推送 + 轮询双通道获取。
        win.webContents.send(PlatformChannels.WebRemoteControlStatusChanged, status);
      },
      embeddedRelay,
      ...(options.resolveWsUrl ? { resolveWsUrl: options.resolveWsUrl } : {}),
    });
    managers.set(webContentsId, manager);
    return manager;
  }

  async function tryRestoreOnWindowTabs(webContentsId: number, paths: string[]): Promise<void> {
    if (restoreConsumed || paths.length === 0) return;
    const firstPath = paths[0];
    if (!firstPath) return;
    const context = await pairing.readLastEnabledContext();
    const autoEnabled = await pairing.readAutoEnabled();
    if (!context) {
      // 常驻可达（spec §1.10）：无历史上下文且未被停止过的用户，首个带 workspace 的窗口自动开启。
      if (!autoEnabled) return;
      restoreConsumed = true;
      options.logger.info("[web-remote-control] auto-enabling session on first workspace", {
        webContentsId,
        workspacePath: firstPath,
      });
      try {
        await getManager(webContentsId).start({ workspacePath: firstPath });
      } catch (error) {
        options.logger.warn("[web-remote-control] auto-enable failed", error);
      }
      return;
    }
    if (!paths.includes(context.workspacePath)) return;
    // 抢占即置位：SyncWindowTabs 可能并发触发，首个匹配窗口独占恢复权。
    restoreConsumed = true;
    options.logger.info("[web-remote-control] restoring last enabled session", {
      webContentsId,
      workspacePath: context.workspacePath,
    });
    try {
      await getManager(webContentsId).start({
        workspacePath: context.workspacePath,
        ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
        ...(context.initialTaskId ? { initialTaskId: context.initialTaskId } : {}),
      });
    } catch (error) {
      options.logger.warn("[web-remote-control] restore failed", error);
    }
  }

  return {
    registerIpc(): void {
      registerWebRemoteControlIpc({
        logger: options.logger,
        getManager,
        tryRestoreOnWindowTabs: (webContentsId, paths) => {
          void tryRestoreOnWindowTabs(webContentsId, paths);
        },
        listPairNics: async () => {
          const egress = await resolveDefaultLanHost();
          const nics = listPairNics(egress?.ip ?? null, egress?.reason);
          let pinned = "";
          try {
            const settings = await options.settingService.get();
            pinned = settings.webRemoteControlPairAddress?.trim() ?? "";
          } catch (error) {
            options.logger.warn("[web-remote-control] read pinned pair address failed", error);
          }
          return { nics, pinned };
        },
        setPairAddress: async (_webContentsId, address) => {
          const trimmed = address.trim();
          // 空串=恢复自动；非空必须是本机候选里的私网 IPv4（防手写不可达地址入码）。
          const egress = await resolveDefaultLanHost();
          const candidates = listPairNics(egress?.ip ?? null, egress?.reason);
          if (trimmed !== "" && !candidates.some((nic) => nic.ip === trimmed)) {
            return { address: trimmed, valid: false, error: "not a local nic candidate" };
          }
          try {
            await options.settingService.update({
              webRemoteControlPairAddress: trimmed === "" ? undefined : trimmed,
            });
          } catch (error) {
            return {
              address: trimmed,
              valid: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          return { address: trimmed, valid: true };
        },
        getExternalRelay: async () => pairing.readExternalRelayUrl(),
        setExternalRelay: async (url) => {
          const trimmed = url.trim();
          // 空串=回内嵌局域网模式；非空必须解析成 http(s) origin（存 origin，去掉尾斜杠）。
          if (trimmed !== "") {
            try {
              const parsed = new URL(trimmed);
              if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
                return { url: trimmed, valid: false, error: "protocol must be http(s)" };
              }
            } catch {
              return { url: trimmed, valid: false, error: "invalid url" };
            }
          }
          try {
            await pairing.writeExternalRelayUrl(trimmed);
          } catch (error) {
            return {
              url: trimmed,
              valid: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          return { url: trimmed, valid: true };
        },
      });
    },
    async handleWindowClosed(webContentsId: number): Promise<void> {
      const manager = managers.get(webContentsId);
      if (!manager) return;
      managers.delete(webContentsId);
      await manager.handleWindowClosed();
    },
    async disposeAll(): Promise<void> {
      reconnectBridge.dispose();
      const all = Array.from(managers.values());
      managers.clear();
      await Promise.all(all.map((manager) => manager.handleWindowClosed()));
      // app 级兜底：万一有会话未走 teardown，直接关停内嵌 relay（幂等）。
      await embeddedRelay.dispose();
    },
  };
}

export type { WebRemoteControlManager } from "./manager.js";
export type { WebRemoteControlPlatformHandlers } from "./appMessageRouter.js";
