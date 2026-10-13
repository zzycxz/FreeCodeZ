// AsyncLocalStorage 属于 node:async_hooks，diagnostics_channel 只导出 channel 等 API；
// 曾误写单个导入导致 ESM 链接期 SyntaxError（主进程启动即崩，弹窗只见行号不见错误名）。
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { randomUUID } from "node:crypto";
// webContents 需要运行时值导入（guest 归属判定）；BrowserWindow/Session 仅类型面。
import { webContents } from "electron";
import type { BrowserWindow, Session } from "electron";
import {
  NETWORK_CAPTURE_BUFFER_LIMIT,
  sanitizeNetworkCaptureUrl,
  type NetworkCaptureRecord,
  type NetworkCaptureSnapshot,
} from "@zcode/shared";

// ============================================================
// U2-6（移植自 ZCode 3.15.1 资源管理器「网络」标签页，上游 NetworkCaptureBuffer
// main@≈467760-469700 逐结构对照）：window-scoped 采集——开窗点亮（captureId 随机），
// 关窗/崩溃即停并清零；「清空」=captureId 全局轮换。采集源：Electron webRequest
// （renderer/main）+ 本进程 node:diagnostics_channel（undici/http）。host/CLI 转发链路
// 见 spec U2-6 stage 2。记录仅请求方向元数据；URL 经 shared 单点脱敏。
// ============================================================

interface CaptureRecordInput {
  timestamp: number;
  processType: NetworkCaptureRecord["processType"];
  pid: number;
  method: string;
  url: string;
}

/** 采集入列载荷：一批记录 + 采样期丢包计数（webRequest 与 host 转发两路共用）。 */
interface CaptureBatchInput {
  records: CaptureRecordInput[];
  dropped: number;
}

class NetworkCaptureBuffer {
  private captureId: string | null = null;
  private records: NetworkCaptureRecord[] = [];
  private dropped = 0;
  private nextId = 0;

  start(id: string): void {
    this.clear();
    this.captureId = id;
  }

  stop(): void {
    this.captureId = null;
    this.clear();
  }

  clear(): void {
    this.records = [];
    this.dropped = 0;
  }

  ingest(batch: CaptureBatchInput, captureId: string | null): void {
    if (this.captureId !== captureId) return;
    this.dropped += batch.dropped;
    for (const record of batch.records) {
      // 冗余脱敏（上游同款双重保险）：webRequest 路径已在入列前脱敏，这里兜底。
      const url = sanitizeNetworkCaptureUrl(record.url);
      if (url === undefined) continue;
      this.records.push({ ...record, url, id: ++this.nextId });
    }
    if (this.records.length > NETWORK_CAPTURE_BUFFER_LIMIT) {
      const overflow = this.records.length - NETWORK_CAPTURE_BUFFER_LIMIT;
      this.records.splice(0, overflow);
      this.dropped += overflow;
    }
  }

  snapshot(): NetworkCaptureSnapshot {
    if (this.captureId === null) throw new Error("Network capture is inactive");
    return { captureId: this.captureId, records: [...this.records], dropped: this.dropped };
  }

  isActive(): boolean {
    return this.captureId !== null;
  }

  currentCaptureId(): string | null {
    return this.captureId;
  }
}

const buffer = new NetworkCaptureBuffer();
let mainWindowWebContentsId: number | null = null;

// ---- 采集源 B：本进程 Node 出网（上游 createNodeNetworkCapture 的 main 侧对应）----

const networkCaptureScope = new AsyncLocalStorage<boolean>();
let diagnosticsBound = false;

function onNodeRequest(
  processType: NetworkCaptureRecord["processType"],
  // 停采路径（captureId=null）也要走这里退订诊断通道；ingest 内部按活跃 captureId 过滤。
  captureId: string | null,
  message: unknown,
): void {
  if (networkCaptureScope.getStore() === true) return;
  if (!buffer.isActive()) return;
  const raw = message as { method?: unknown; url?: unknown };
  if (typeof raw.method !== "string" || typeof raw.url !== "string") return;
  if (raw.method.toUpperCase() === "CONNECT") return;
  const url = sanitizeNetworkCaptureUrl(raw.url);
  if (url === undefined) return;
  buffer.ingest(
    {
      records: [
        {
          timestamp: Date.now(),
          processType,
          pid: process.pid,
          method: raw.method.slice(0, 32),
          url,
        },
      ],
      dropped: 0,
    },
    captureId,
  );
}

function bindNodeDiagnostics(captureId: string | null): void {
  const undiciChannel = channel("undici:request:create");
  const httpChannel = channel("http.client.request:start");
  if (diagnosticsBound) {
    undiciChannel.unsubscribe((message) => onNodeRequest("main", captureId, message));
    httpChannel.unsubscribe((message) => onNodeRequest("main", captureId, message));
    diagnosticsBound = false;
  }
  if (captureId === null) return;
  undiciChannel.subscribe((message) => onNodeRequest("main", captureId, message));
  httpChannel.subscribe((message) => onNodeRequest("main", captureId, message));
  diagnosticsBound = true;
}

export function withoutNetworkCapture<T>(fn: () => T): T {
  return networkCaptureScope.run(true, fn);
}

// ---- 采集源 A：Electron webRequest（共享订阅合并——Electron 单监听器限制）----

type BeforeRequestListener = (details: {
  method: string;
  url: string;
  webContentsId: number | null;
}) => void;

const webRequestListeners = new WeakMap<Session["webRequest"], Set<BeforeRequestListener>>();

function subscribeBeforeRequest(
  webRequest: Session["webRequest"],
  filter: string[],
  listener: BeforeRequestListener,
): () => void {
  let listeners = webRequestListeners.get(webRequest);
  if (!listeners) {
    listeners = new Set();
    webRequestListeners.set(webRequest, listeners);
    webRequest.onBeforeRequest({ urls: filter }, (details, callback) => {
      const set = webRequestListeners.get(webRequest);
      if (set) {
        for (const entry of set) {
          entry({ method: details.method, url: details.url, webContentsId: details.webContents?.id ?? null });
        }
      }
      // 采集是旁路：不拦截不重定向。
      callback({});
    });
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---- 生命周期与查询面 ----

let activeWebRequestUnsubs: Array<() => void> = [];

const WEB_REQUEST_FILTER: string[] = ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"];

function startResourceManagerNetwork(
  win: Electron.WebContents,
  embeddedSession: Session | undefined,
): string {
  const captureId = randomUUID();
  buffer.start(captureId);
  mainWindowWebContentsId = win.id;
  bindNodeDiagnostics(captureId);
  activeWebRequestUnsubs = [];
  // 采集会话：主窗口 default session + 内置浏览器 partition。上游排除 remote guest
  // 的意图在 FC 对应为排除 <webview> guest（见回调）——记录应用自身出网，站点流量不灌列表。
  const sessions: Session[] = embeddedSession ? [win.session, embeddedSession] : [win.session];
  for (const session of sessions) {
    const unsubscribe = subscribeBeforeRequest(
      session.webRequest,
      WEB_REQUEST_FILTER,
      (details) => {
        if (!buffer.isActive()) return;
        const guest = webContents.fromId(details.webContentsId ?? -1);
        if (guest && guest.isDestroyed()) return;
        if (guest && guest.getType() === "webview") return;
        const url = sanitizeNetworkCaptureUrl(details.url);
        if (url === undefined) return;
        buffer.ingest(
          {
            records: [
              {
                timestamp: Date.now(),
                processType: details.webContentsId === null ? "main" : "renderer",
                pid: guest ? guest.getOSProcessId() : process.pid,
                method: details.method.slice(0, 32),
                url,
              },
            ],
            dropped: 0,
          },
          captureId,
        );
      },
    );
    activeWebRequestUnsubs.push(unsubscribe);
  }
  return captureId;
}

export function stopResourceManagerNetwork(notifyHosts: (captureId: string | null) => void): void {
  if (!buffer.isActive()) return;
  notifyHosts(null);
  bindNodeDiagnostics(null);
  for (const unsubscribe of activeWebRequestUnsubs) unsubscribe();
  activeWebRequestUnsubs = [];
  mainWindowWebContentsId = null;
  buffer.stop();
}

export function getNetworkCaptureSnapshot(senderId: number): NetworkCaptureSnapshot {
  if (
    mainWindowWebContentsId !== senderId ||
    mainWindowWebContentsId === null ||
    !buffer.isActive()
  ) {
    throw new Error("Network capture is inactive");
  }
  return buffer.snapshot();
}

export function clearNetworkCapture(senderId: number): boolean {
  // 上游语义：清空=captureId 全局轮换（host/CLI 侧退订再订阅；stage 2 接线）。
  if (mainWindowWebContentsId !== senderId || !buffer.isActive()) return false;
  buffer.start(randomUUID());
  return true;
}

/**
 * 挂接资源管理器窗口生命周期（openResourceManager 创建窗口后调用一次）：
 * 开窗点亮采集；closed/render-process-gone/destroyed 三事件停并清零。
 */
export function observeResourceManagerNetworkWindow(
  win: BrowserWindow,
  notifyHosts: (captureId: string | null) => void,
  embeddedSession?: Session,
): void {
  const stop = (): void => stopResourceManagerNetwork(notifyHosts);
  const start = (): void => {
    const captureId = startResourceManagerNetwork(win.webContents, embeddedSession);
    notifyHosts(captureId);
  };
  start();
  // closed 是 BrowserWindow 事件；render-process-gone/destroyed 属 webContents——
  // 挂错宿主在运行时是静默 no-op（EventEmitter 透传），这里按事件真实归属挂载。
  win.on("closed", stop);
  win.webContents.on("render-process-gone", stop);
  win.webContents.on("destroyed", stop);
}

/** host→main 的 capture batch 入口（desktopHostProcess 消息路由调用；stage 2 接线）。 */
export function ingestHostNetworkCapture(batch: unknown, hostPid: number): void {
  const parsed = batch as {
    captureId?: string;
    dropped?: number;
    records?: { timestamp?: number; processType?: string; pid?: number; method?: string; url?: string }[];
  };
  if (
    typeof parsed?.captureId !== "string" ||
    !Array.isArray(parsed.records) ||
    !buffer.isActive()
  ) {
    return;
  }
  buffer.ingest(
    {
      dropped: typeof parsed.dropped === "number" ? parsed.dropped : 0,
      records: parsed.records
        .filter(
          (record): record is { timestamp: number; processType: "host" | "cli"; pid: number; method: string; url: string } =>
            typeof record.timestamp === "number" &&
            (record.processType === "host" || record.processType === "cli") &&
            typeof record.pid === "number" &&
            typeof record.method === "string" &&
            typeof record.url === "string",
        )
        .map((record) => ({
          timestamp: record.timestamp,
          processType: record.processType,
          // host 记录的 pid 统一覆写为 host 子进程 pid（上游同款归因）。
          pid: hostPid || record.pid,
          method: record.method.slice(0, 32),
          url: record.url,
        })),
    },
    parsed.captureId,
  );
}

