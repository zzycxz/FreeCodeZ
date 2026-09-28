import { randomUUID } from "node:crypto";
import {
  WEB_REMOTE_CONTROL_LIMITS,
  type WebRemoteControlContext,
  type WebRemoteControlStatus,
} from "@zcode/shared/web-remote-control";
import { createManagerRelayTransport } from "./managerTransport.js";
import type { EmbeddedRelayEndpoints } from "./embeddedRelay.js";
import type { RelayPairingStore } from "./pairing.js";
import type { AppMessageRouter } from "./appMessageRouter.js";
import type { ActiveSession, StartToken, WebRemoteControlManagerLogger } from "./managerTypes.js";
import { buildWebRemoteControlPairingUrls } from "./pairing.js";

// 启动程序段（附录A §7）：一次性授权 token TTL 30s、QR-ready 等待 30s、
// 握手就绪后生成配对 URL 并转入 running(等待手机连接)。状态写入经 hooks 回到 Manager（唯一状态所有者）。

export interface ManagerStartHooks {
  now(): number;
  logger: WebRemoteControlManagerLogger;
  pairing: RelayPairingStore;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  resolveWsUrl?: () => string;
  /** 内嵌 relay（spec §5）：启动前获取端点（外部模式返回外部地址，embedded=false）。 */
  acquireRelay(): Promise<EmbeddedRelayEndpoints | null>;
  setStatus(status: WebRemoteControlStatus["status"]): void;
  setFailure(failure: NonNullable<WebRemoteControlStatus["failure"]> | null): void;
  setErrorText(text: string | undefined): void;
  clearFailure(): void;
  handlePairStatusWaiting(): void;
  handlePairStatusMatched(): void;
  handleRelayData(payload: unknown): void;
  handlePaired(): void;
  handleRecoverableError(message: string): void;
  createSessionRouter(): AppMessageRouter;
  attachSession(session: ActiveSession): void;
  isActiveSession(session: ActiveSession): boolean;
  teardownRuntime(notifyMobile: boolean): void;
  writeLastEnabledContext(context: WebRemoteControlContext): Promise<void>;
  /** 局域网常驻可达（spec §1.10）：start 成功置 true / stop 置 false（Manager 闭包注入）。 */
  writeAutoEnabled(enabled: boolean): Promise<void>;
  buildStatus(): WebRemoteControlStatus;
  clearStartToken(): void;
}

export function createStartToken(nowMs: number, ttlMs: number): StartToken {
  let abort: () => void = () => undefined;
  const abortPromise = new Promise<"aborted">((resolve) => {
    abort = () => resolve("aborted");
  });
  return { expiresAt: nowMs + ttlMs, cancelled: false, abortPromise, abort };
}

export function cancelStartToken(token: StartToken | null): void {
  if (!token || token.cancelled) return;
  token.cancelled = true;
  token.abort();
}

export async function performManagerStart(
  hooks: ManagerStartHooks,
  context: WebRemoteControlContext,
  token: StartToken,
): Promise<WebRemoteControlStatus | { status: "cancelled" }> {
  const credentials = await hooks.pairing.ensureCredentials();
  if (token.cancelled) {
    return { status: "cancelled" };
  }
  // 内嵌 relay 先于 transport 启动（spec §5）：端口顺延后 transport/QR 都用实际端口。
  let relay: EmbeddedRelayEndpoints | null = null;
  try {
    relay = await hooks.acquireRelay();
  } catch (error) {
    hooks.setErrorText(
      error instanceof Error ? error.message : `内嵌 relay 获取失败: ${String(error)}`,
    );
    hooks.setStatus("error");
    return hooks.buildStatus();
  }
  if (token.cancelled) {
    return { status: "cancelled" };
  }
  type ReadyOutcome = { kind: "ready"; deviceSid: string } | { kind: "failed"; error: string };
  let settleReady: (outcome: ReadyOutcome) => void = () => undefined;
  const readyPromise = new Promise<ReadyOutcome>((resolve) => {
    settleReady = resolve;
  });
  const transport = createManagerRelayTransport({
    deviceMid: hooks.deviceMid,
    deviceName: hooks.deviceName,
    appVersion: hooks.appVersion,
    resolvePassHash: async () => (await hooks.pairing.ensureCredentials()).passHash,
    persistDeviceSid: (deviceSid) => hooks.pairing.persistDeviceSid(deviceSid),
    // 端点优先级：显式 resolveWsUrl（env/组装层注入）> 内嵌 relay 实际端口 > 默认端点。
    ...(hooks.resolveWsUrl
      ? { resolveWsUrl: hooks.resolveWsUrl }
      : relay
        ? { resolveWsUrl: () => relay.wsUrl }
        : {}),
    logger: hooks.logger,
    now: hooks.now,
    callbacks: {
      onReady: (deviceSid) => settleReady({ kind: "ready", deviceSid }),
      onPairStatusChanged: (status) => {
        if (status === "matched") {
          hooks.handlePairStatusMatched();
          return;
        }
        hooks.handlePairStatusWaiting();
      },
      onPaired: () => {
        hooks.handlePaired();
      },
      onData: (payload) => hooks.handleRelayData(payload),
      onKicked: (message) => {
        // 单终端配对：第二手机页把旧配对踢下线。KICKED → session-conflict（含 kicked 文案分流）。
        hooks.setFailure({ reason: "session-conflict", message: `kicked: ${message}` });
        hooks.setStatus("error");
        hooks.teardownRuntime(false);
      },
      onFatalError: (message) => {
        settleReady({ kind: "failed", error: message });
        hooks.clearFailure();
        hooks.setErrorText(message);
        hooks.setStatus("error");
        hooks.teardownRuntime(false);
      },
      onRecoverableError: (message) => hooks.handleRecoverableError(message),
    },
  });
  const active: ActiveSession = {
    sessionId: randomUUID(),
    context,
    qrUrl: "",
    connectUrl: "",
    transport,
    router: hooks.createSessionRouter(),
    relayLease: relay?.embedded === true,
  };
  hooks.attachSession(active);
  transport.start();
  // QR-ready 等待 30s：注册+鉴权完成才能拿到 deviceSid 生成配对 URL。
  const timeout = new Promise<"timeout">((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), WEB_REMOTE_CONTROL_LIMITS.qrReadyTimeoutMs);
    timer.unref?.();
  });
  const outcome = await Promise.race([readyPromise, timeout, token.abortPromise]);
  if (token.cancelled || outcome === "aborted") {
    if (hooks.isActiveSession(active)) hooks.teardownRuntime(false);
    return { status: "cancelled" };
  }
  if (outcome === "timeout") {
    if (hooks.isActiveSession(active)) {
      hooks.setErrorText("等待 relay 就绪超时（QR-ready 30s）");
      hooks.setStatus("error");
      hooks.teardownRuntime(false);
    }
    return hooks.buildStatus();
  }
  if (outcome.kind === "failed") {
    // fatal 路径已置 error 并 teardown，这里只回填最终状态。
    return hooks.buildStatus();
  }
  if (hooks.now() > token.expiresAt) {
    // 一次性授权 token TTL 30s：超期的启动流程无权复活会话。
    if (hooks.isActiveSession(active)) hooks.teardownRuntime(false);
    return { status: "cancelled" };
  }
  const deviceSid = transport.getDeviceSid() ?? outcome.deviceSid ?? credentials.deviceSid;
  if (!deviceSid) {
    if (hooks.isActiveSession(active)) {
      hooks.setErrorText("relay 未分配 deviceSid");
      hooks.setStatus("error");
      hooks.teardownRuntime(false);
    }
    return hooks.buildStatus();
  }
  const urls = buildWebRemoteControlPairingUrls({
    deviceSid,
    passHash: credentials.passHash,
    deviceMid: hooks.deviceMid,
    deviceName: hooks.deviceName,
    appVersion: hooks.appVersion,
    now: hooks.now,
    // 配对页基址：内嵌 relay 的 LAN 地址（env 覆盖已在此内处理），无 relay 时回落 env/默认。
    ...(relay ? { pageBaseUrl: relay.pageBaseUrl } : {}),
  });
  active.qrUrl = urls.qrUrl;
  active.connectUrl = urls.connectUrl;
  hooks.clearFailure();
  hooks.clearStartToken();
  hooks.setStatus("running");
  await hooks.writeLastEnabledContext(context);
  // 常驻可达：成功开启即恢复自动（此前可能被停止按钮置 false，spec §1.10）。
  await hooks.writeAutoEnabled(true);
  hooks.logger.info("[web-remote-manager] session running", { sessionId: active.sessionId });
  return hooks.buildStatus();
}
