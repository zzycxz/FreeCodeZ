import { BrowserWindow, ipcMain } from "electron";
import { z } from "zod";
import { PlatformChannels, formatZodError, stringArraySchema } from "@zcode/shared";
import {
  WEB_REMOTE_CONTROL_LIMITS,
  remoteTaskListItemSchema,
  remoteWorkspaceDescriptorSchema,
  webRemoteControlContextSchema,
} from "@zcode/shared/web-remote-control";
import type { WebRemoteControlManager } from "./manager.js";
import type { LanNicCandidate } from "./lanAddress.js";

// webRemoteControlIpc：10 通道 IPC 注册（模式照 desktopMainIpcPlatform.ts，zod 校验载荷）+
// WebRemoteControlReconnectWorkspace 双向 invoke 桥（requestId 配对、120s 超时）+
// SyncWindowTabs 挂 restore（官方同款触发点）+ 配对网卡列出/钉选（spec §5 LAN 地址选取）。

export interface WebRemoteControlIpcLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

const setPairAddressPayloadSchema = z
  .object({ address: z.string() })
  .strict();

const externalRelayPayloadSchema = z
  .object({ url: z.string() })
  .strict();

export interface RendererReconnectBridge {
  request(
    webContentsId: number,
    requestId: string,
    workspaceKey: string,
  ): Promise<{ success: boolean; error?: string }>;
  dispose(): void;
}

interface PendingReconnect {
  resolve: (result: { success: boolean; error?: string }) => void;
  timer: NodeJS.Timeout;
}

export function createRendererReconnectBridge(logger: WebRemoteControlIpcLogger): RendererReconnectBridge {
  const pending = new Map<string, PendingReconnect>();

  const listener = (_event: unknown, raw: unknown): void => {
    if (typeof raw !== "object" || raw === null) return;
    const payload = raw as { requestId?: unknown; success?: unknown; error?: unknown };
    if (typeof payload.requestId !== "string" || typeof payload.success !== "boolean") return;
    const entry = pending.get(payload.requestId);
    if (!entry) return;
    pending.delete(payload.requestId);
    clearTimeout(entry.timer);
    entry.resolve({
      success: payload.success,
      ...(typeof payload.error === "string" ? { error: payload.error } : {}),
    });
  };
  ipcMain.on(PlatformChannels.WebRemoteControlReconnectWorkspace, listener);

  return {
    request(webContentsId, requestId, workspaceKey) {
      const win = findWindowByWebContentsId(webContentsId);
      if (!win) {
        return Promise.resolve({ success: false, error: "窗口已关闭" });
      }
      return new Promise<{ success: boolean; error?: string }>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          logger.warn("[web-remote-ipc] renderer workspace reconnect timed out", requestId);
          resolve({ success: false, error: "renderer reconnect timeout" });
        }, WEB_REMOTE_CONTROL_LIMITS.rendererReconnectTimeoutMs);
        timer.unref?.();
        pending.set(requestId, { resolve, timer });
        win.webContents.send(PlatformChannels.WebRemoteControlReconnectWorkspace, {
          requestId,
          workspaceKey,
        });
      });
    },
    dispose() {
      ipcMain.removeListener(PlatformChannels.WebRemoteControlReconnectWorkspace, listener);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.resolve({ success: false, error: "disposed" });
      }
      pending.clear();
    },
  };
}

export function findWindowByWebContentsId(webContentsId: number): BrowserWindow | null {
  return (
    BrowserWindow.getAllWindows().find(
      (win) => !win.isDestroyed() && win.webContents.id === webContentsId,
    ) ?? null
  );
}

export function registerWebRemoteControlIpc(options: {
  logger: WebRemoteControlIpcLogger;
  getManager(webContentsId: number): WebRemoteControlManager;
  tryRestoreOnWindowTabs(webContentsId: number, paths: string[]): void;
  /** 配对网卡候选与钉选读写（subsystem 注入：settings + 默认路由出口解析）。 */
  listPairNics(): Promise<{ nics: LanNicCandidate[]; pinned: string }>;
  setPairAddress(
    webContentsId: number,
    address: string,
  ): Promise<{ address: string; valid: boolean; error?: string }>;
  /** 远程访问开放能力（spec §1.11）：自建中继 origin 读写。 */
  getExternalRelay(): Promise<string>;
  setExternalRelay(
    url: string,
  ): Promise<{ url: string; valid: boolean; error?: string }>;
}): void {
  const { logger } = options;

  ipcMain.handle(PlatformChannels.StartWebRemoteControl, (event, raw: unknown) => {
    const parsed = webRemoteControlContextSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn("[web-remote-ipc] invalid start context:", formatZodError(parsed.error));
      return { status: "cancelled" } as const;
    }
    return options.getManager(event.sender.id).start(parsed.data);
  });

  ipcMain.handle(PlatformChannels.ResetWebRemoteControlPairing, (event, raw: unknown) => {
    const parsed = webRemoteControlContextSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn("[web-remote-ipc] invalid refresh context:", formatZodError(parsed.error));
      return { status: "cancelled" } as const;
    }
    return options.getManager(event.sender.id).refreshPairing(parsed.data);
  });

  ipcMain.handle(PlatformChannels.StopWebRemoteControl, (event) =>
    options.getManager(event.sender.id).stop(),
  );

  ipcMain.handle(PlatformChannels.GetWebRemoteControlStatus, (event) =>
    options.getManager(event.sender.id).getStatus(),
  );

  ipcMain.handle(PlatformChannels.ListWebRemoteControlPairNics, () => options.listPairNics());

  ipcMain.handle(PlatformChannels.GetWebRemoteControlExternalRelay, () =>
    options.getExternalRelay(),
  );

  ipcMain.handle(PlatformChannels.SetWebRemoteControlExternalRelay, (_event, raw: unknown) => {
    const parsed = externalRelayPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn("[web-remote-ipc] invalid external relay payload:", formatZodError(parsed.error));
      return { url: "", valid: false, error: "invalid payload" } as const;
    }
    return options.setExternalRelay(parsed.data.url);
  });

  ipcMain.handle(PlatformChannels.SetWebRemoteControlPairAddress, async (event, raw: unknown) => {
    const parsed = setPairAddressPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn("[web-remote-ipc] invalid pair address payload:", formatZodError(parsed.error));
      return { address: "", valid: false, error: "invalid payload" } as const;
    }
    const result = await options.setPairAddress(event.sender.id, parsed.data.address);
    if (result.valid) {
      // 钉选变更即时重建活动会话的配对 URL（sid/hash 不轮换）。
      await options.getManager(event.sender.id).rebuildPairingUrls();
    }
    return result;
  });

  ipcMain.on(PlatformChannels.SyncWebRemoteControlWorkspaces, (event, raw: unknown) => {
    if (!Array.isArray(raw)) {
      logger.warn("[web-remote-ipc] invalid workspaces snapshot");
      return;
    }
    const workspaces = raw
      .map((entry) => remoteWorkspaceDescriptorSchema.safeParse(entry))
      .filter((result) => result.success)
      .map((result) => result.data);
    options.getManager(event.sender.id).syncWorkspaces(workspaces);
  });

  ipcMain.on(PlatformChannels.SyncWebRemoteControlTasks, (event, raw: unknown) => {
    if (!Array.isArray(raw)) {
      logger.warn("[web-remote-ipc] invalid tasks snapshot");
      return;
    }
    const tasks = raw
      .map((entry) => remoteTaskListItemSchema.safeParse(entry))
      .filter((result) => result.success)
      .map((result) => result.data);
    options.getManager(event.sender.id).syncTasks(tasks);
  });

  // 重启恢复挂在 SyncWindowTabs 处理器触发（官方同款）；独立监听器与平台侧互不干扰。
  ipcMain.on(PlatformChannels.SyncWindowTabs, (event, raw: unknown) => {
    const result = stringArraySchema.safeParse(raw);
    if (!result.success) return;
    options.tryRestoreOnWindowTabs(event.sender.id, result.data);
  });
}
