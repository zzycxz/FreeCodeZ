import { buildPairingUrl, resolveRemotePageUrl } from "@zcode/shared/web-remote-control";
import {
  CREDENTIAL_KEY_RELAY_PASS_HASH,
  generateRelayPassword,
  hashRelayPassword,
} from "@zcode/shared/web-remote-control/auth-node";
import type { WebRemoteControlContext } from "@zcode/shared/web-remote-control";

// pairing：relay 凭据（password/passHash 经 ICredentialService 同款工厂持久化）与 settings 键
// （webRemoteControlExternalRelayDevice / webRemoteControlLastEnabledContext）的唯一读写方。
// password 只在本地 credential 仓库存放，从不上传；passHash 上行注册，proof 响应挑战。
// rotate 语义：清 sid+passHash（含 password）→ 重新生成，旧配对链接立即 session-not-found。

export interface RelayCredentialState {
  password: string;
  passHash: string;
  deviceSid?: string;
}

export interface WebRemoteControlLastEnabledContext {
  workspacePath: string;
  workspaceIdentity?: string;
  initialTaskId?: string;
}

interface CredentialServiceLike {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

interface SettingServiceLike {
  get(): Promise<{
    webRemoteControlExternalRelayDevice?: { deviceSid: string };
    webRemoteControlLastEnabledContext?: WebRemoteControlLastEnabledContext;
    /** 配对网卡钉选（spec §5）：空/缺省=自动；subsystem 的 LAN 解析与 IPC 钉选读写消费。 */
    webRemoteControlPairAddress?: string;
    /** 局域网常驻可达（spec §1.10）：缺省=true。 */
    webRemoteControlAutoEnabled?: boolean;
    /** 远程访问开放能力（spec §1.11）：自建中继 origin；空=内嵌局域网模式。 */
    webRemoteControlExternalRelayUrl?: string;
  }>;
  update(patch: Record<string, unknown>): Promise<void>;
}

/** password 的本地持久化键；与 pass_hash 键同属 web-remote-control:* 族（legacy cleanup 明确保留）。 */
const CREDENTIAL_KEY_RELAY_PASSWORD = "web-remote-control:external-relay:password";

export interface RelayPairingStore {
  ensureCredentials(): Promise<RelayCredentialState>;
  /** rotate：停 runtime 后调用；清 sid+passHash 后重新生成。 */
  rotate(): Promise<RelayCredentialState>;
  /** relay 注册回包后持久化 deviceSid（settings 键 webRemoteControlExternalRelayDevice）。 */
  persistDeviceSid(deviceSid: string): Promise<void>;
  readLastEnabledContext(): Promise<WebRemoteControlLastEnabledContext | undefined>;
  writeLastEnabledContext(context: WebRemoteControlContext): Promise<void>;
  clearLastEnabledContext(): Promise<void>;
  /** 局域网常驻可达（spec §1.10）：缺省=true；停止显式置 false，start 成功恢复 true。 */
  readAutoEnabled(): Promise<boolean>;
  writeAutoEnabled(enabled: boolean): Promise<void>;
  /** 远程访问开放能力（spec §1.11）：自建中继 origin；空=内嵌局域网模式。 */
  readExternalRelayUrl(): Promise<string>;
  writeExternalRelayUrl(url: string): Promise<void>;
}

export function createRelayPairingStore(options: {
  credentialService: CredentialServiceLike;
  settingService: SettingServiceLike;
  logger: { warn(...args: unknown[]): void };
}): RelayPairingStore {
  let cached: RelayCredentialState | null = null;

  async function loadCredentials(): Promise<RelayCredentialState | null> {
    const [password, passHash, settings] = await Promise.all([
      options.credentialService.load(CREDENTIAL_KEY_RELAY_PASSWORD),
      options.credentialService.load(CREDENTIAL_KEY_RELAY_PASS_HASH),
      options.settingService.get(),
    ]);
    const deviceSid = settings.webRemoteControlExternalRelayDevice?.deviceSid;
    if (passHash) {
      return { password: password ?? "", passHash, ...(deviceSid ? { deviceSid } : {}) };
    }
    if (password) {
      return { password, passHash: hashRelayPassword(password), ...(deviceSid ? { deviceSid } : {}) };
    }
    return null;
  }

  async function createCredentials(): Promise<RelayCredentialState> {
    const password = generateRelayPassword();
    const passHash = hashRelayPassword(password);
    await Promise.all([
      options.credentialService.save(CREDENTIAL_KEY_RELAY_PASSWORD, password),
      options.credentialService.save(CREDENTIAL_KEY_RELAY_PASS_HASH, passHash),
    ]);
    return { password, passHash };
  }

  async function clearCredentials(): Promise<void> {
    await Promise.all([
      options.credentialService.delete(CREDENTIAL_KEY_RELAY_PASSWORD).catch(() => undefined),
      options.credentialService.delete(CREDENTIAL_KEY_RELAY_PASS_HASH).catch(() => undefined),
      options.settingService
        .update({ webRemoteControlExternalRelayDevice: undefined })
        .catch((error: unknown) => {
          options.logger.warn("[web-remote-pairing] clear deviceSid failed", error);
        }),
    ]);
    cached = null;
  }

  return {
    async ensureCredentials(): Promise<RelayCredentialState> {
      if (cached) return cached;
      const existing = await loadCredentials();
      cached = existing ?? (await createCredentials());
      return cached;
    },
    async rotate(): Promise<RelayCredentialState> {
      await clearCredentials();
      cached = await createCredentials();
      return cached;
    },
    async persistDeviceSid(deviceSid: string): Promise<void> {
      if (cached) {
        cached = { ...cached, deviceSid };
      }
      await options.settingService
        .update({ webRemoteControlExternalRelayDevice: { deviceSid } })
        .catch((error: unknown) => {
          options.logger.warn("[web-remote-pairing] persist deviceSid failed", error);
        });
    },
    async readLastEnabledContext(): Promise<WebRemoteControlLastEnabledContext | undefined> {
      try {
        const settings = await options.settingService.get();
        return settings.webRemoteControlLastEnabledContext;
      } catch (error) {
        options.logger.warn("[web-remote-pairing] read last enabled context failed", error);
        return undefined;
      }
    },
    async writeLastEnabledContext(context: WebRemoteControlContext): Promise<void> {
      try {
        await options.settingService.update({
          webRemoteControlLastEnabledContext: {
            workspacePath: context.workspacePath,
            ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
            ...(context.initialTaskId ? { initialTaskId: context.initialTaskId } : {}),
          },
        });
      } catch (error) {
        options.logger.warn("[web-remote-pairing] write last enabled context failed", error);
      }
    },
    async clearLastEnabledContext(): Promise<void> {
      try {
        await options.settingService.update({ webRemoteControlLastEnabledContext: undefined });
      } catch (error) {
        options.logger.warn("[web-remote-pairing] clear last enabled context failed", error);
      }
    },
    async readAutoEnabled(): Promise<boolean> {
      try {
        const settings = await options.settingService.get();
        // 缺省=true：从未停止过的用户默认获得局域网常驻可达。
        return settings.webRemoteControlAutoEnabled !== false;
      } catch (error) {
        options.logger.warn("[web-remote-pairing] read auto enabled failed", error);
        return true;
      }
    },
    async writeAutoEnabled(enabled: boolean): Promise<void> {
      try {
        await options.settingService.update({ webRemoteControlAutoEnabled: enabled });
      } catch (error) {
        options.logger.warn("[web-remote-pairing] write auto enabled failed", error);
      }
    },
    async readExternalRelayUrl(): Promise<string> {
      try {
        const settings = await options.settingService.get();
        return settings.webRemoteControlExternalRelayUrl?.trim() ?? "";
      } catch (error) {
        options.logger.warn("[web-remote-pairing] read external relay url failed", error);
        return "";
      }
    },
    async writeExternalRelayUrl(url: string): Promise<void> {
      // trim + 去尾斜杠：存储端统一 origin 形态，读取方不再各自归一。
      const trimmed = url.trim().replace(/\/+$/, "");
      try {
        await options.settingService.update({
          webRemoteControlExternalRelayUrl: trimmed === "" ? undefined : trimmed,
        });
      } catch (error) {
        options.logger.warn("[web-remote-pairing] write external relay url failed", error);
      }
    },
  };
}

/** 配对 URL：…?sid&hash&t&mid&name&app_version（qrUrl 与 connectUrl 同一 URL，前端 toDataURL 渲染二维码）。 */
export function buildWebRemoteControlPairingUrls(params: {
  deviceSid: string;
  passHash: string;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  now?: () => number;
  /** 配对页基址（内嵌 relay 的 LAN 地址）；缺省回落 env/默认端点（resolveRemotePageUrl）。 */
  pageBaseUrl?: string;
}): { qrUrl: string; connectUrl: string } {
  const url = buildPairingUrl(params.pageBaseUrl ?? resolveRemotePageUrl(process.env), {
    sid: params.deviceSid,
    hash: params.passHash,
    t: (params.now ?? (() => Date.now()))(),
    mid: params.deviceMid,
    name: params.deviceName,
    app_version: params.appVersion,
  });
  return { qrUrl: url, connectUrl: url };
}
