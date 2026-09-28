import type { RelayPairStatus } from "@zcode/shared/web-remote-control";
import { createRelayTransport, type RelayTransport, type RelayTransportLogger } from "./relayTransport.js";

// Manager 侧 RelayTransport 装配：把附录A §1 的握手/心跳/重连传输与 Manager 状态机解耦，
// 事件经回调上抛（ready/paired/kicked/data/错误分级），凭据读写与 deviceSid 持久化由调用方注入。

export interface ManagerTransportCallbacks {
  /** 注册+鉴权完成（附带 relay 分配的 deviceSid）。 */
  onReady(deviceSid: string): void;
  onPairStatusChanged(status: RelayPairStatus): void;
  onPaired(): void;
  onData(payload: unknown): void;
  onKicked(message: string): void;
  /** fatal（AUTH_FAILED/WRONG_PARAM 等）：不再重连。 */
  onFatalError(message: string): void;
  onRecoverableError(message: string): void;
}

export function createManagerRelayTransport(params: {
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  resolvePassHash(): Promise<string>;
  persistDeviceSid(deviceSid: string): Promise<void>;
  resolveWsUrl?: () => string;
  logger: RelayTransportLogger;
  now(): number;
  callbacks: ManagerTransportCallbacks;
}): RelayTransport {
  return createRelayTransport({
    deviceMid: params.deviceMid,
    deviceMeta: () => ({
      platform: process.platform,
      version: params.appVersion,
      name: params.deviceName,
    }),
    resolvePassHash: params.resolvePassHash,
    persistDeviceSid: params.persistDeviceSid,
    ...(params.resolveWsUrl ? { resolveWsUrl: params.resolveWsUrl } : {}),
    logger: params.logger,
    now: params.now,
    events: {
      onStateChanged: () => undefined,
      onPairStatusChanged: (status) => params.callbacks.onPairStatusChanged(status),
      onReady: (deviceSid) => params.callbacks.onReady(deviceSid),
      onPaired: () => params.callbacks.onPaired(),
      onData: (payload) => params.callbacks.onData(payload),
      onKicked: (message) => params.callbacks.onKicked(message),
      onError: (message, fatal) => {
        if (fatal) {
          params.callbacks.onFatalError(message);
          return;
        }
        params.callbacks.onRecoverableError(message);
      },
    },
  });
}
