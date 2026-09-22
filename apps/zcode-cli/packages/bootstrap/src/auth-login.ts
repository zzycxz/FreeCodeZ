// FreeCodeZ fork(model-provider-intake R1):bigmodel+zai 账号登录链(standalone account
// provider / OAuth 凭据簿 / Coding Plan 账号开通)已随账号族整体移除，接入面收敛为
// API Key / 自定义供应商单轨。这里保留既有导出签名供 CLI/TUI 编译与调用，
// 账号类入口运行时显式报「不支持」；CLI 登录面的物理拆除留待品牌清扫批次。
import {
  createCodingPlanApiKeyResolver,
  createSharedZCodeCredentialStore,
  createCliOAuthClient,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  type BrowserOpenResult,
  type SharedZCodeCredentialStore,
  type CliOAuthInitData,
  type CliOAuthPollData,
  type CliOAuthUser,
} from "@zcode/adapters";
import type { EnvRecord } from "@zcode/adapters/model";

export type CodingPlanProviderId = "bigmodel" | "zai";

export interface LoginZCodeCliOptions {
  providerId?: CodingPlanProviderId;
  abortSignal?: AbortSignal;
  apiKeyResolver?: ReturnType<typeof createCodingPlanApiKeyResolver>;
  baseUrl?: string;
  credentialStore?: SharedZCodeCredentialStore;
  env?: EnvRecord;
  httpClient?: Parameters<typeof createCliOAuthClient>[0]["httpClient"];
  noBrowser?: boolean;
  now?: () => number;
  onAuthorizeUrl?: (data: CliOAuthInitData) => void | Promise<void>;
  onBrowserOpen?: (result: BrowserOpenResult) => void | Promise<void>;
  onPollStatus?: (data: CliOAuthPollData) => void | Promise<void>;
  openBrowser?: (url: string) => Promise<BrowserOpenResult>;
  pollToken?: string;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  personalProviderConfigPath?: string;
}

export interface LoginZCodeCliResult {
  browser?: BrowserOpenResult;
  configPath: string;
  credentialsPath: string;
  model: string;
  providerId: CodingPlanProviderId;
  user: CliOAuthUser;
}

export type LoginBigmodelCodingPlanOptions = Omit<LoginZCodeCliOptions, "providerId">;
export type LoginBigmodelCodingPlanResult = LoginZCodeCliResult & { providerId: "bigmodel" };

export interface ConfigureCodingPlanApiKeyOptions {
  apiKey: string;
  credentialStore?: SharedZCodeCredentialStore;
  env?: EnvRecord;
  personalProviderConfigPath?: string;
  providerId: CodingPlanProviderId;
}

export interface ConfigureCodingPlanApiKeyResult {
  configPath: string;
  model: string;
  providerId: CodingPlanProviderId;
}

export interface LogoutZCodeCliOptions {
  credentialStore?: SharedZCodeCredentialStore;
  env?: EnvRecord;
}

export interface LogoutZCodeCliResult {
  credentialsPath: string;
}

const ACCOUNT_LOGIN_REMOVED_MESSAGE =
  "账号登录与 Coding Plan 账号开通已随 bigmodel+zai 账号族移除；请在模型设置的「添加供应商」中以 API Key / 自定义供应商接入。";

export async function hasConfiguredStandaloneCodingPlan(
  _options: {
    credentialStore?: SharedZCodeCredentialStore;
    env?: EnvRecord;
  } = {},
): Promise<boolean> {
  // 账号族移除后不存在 standalone Coding Plan 账号接入。
  return false;
}

export class ZCodeCliLoginError extends Error {
  readonly code:
    | "auth_failed"
    | "auth_timeout"
    | "config_update_failed"
    | "credential_write_failed";

  constructor(
    code: ZCodeCliLoginError["code"],
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "ZCodeCliLoginError";
    this.code = code;
  }
}

export async function loginZCodeCli(
  _options: LoginZCodeCliOptions = {},
): Promise<LoginZCodeCliResult> {
  throw new ZCodeCliLoginError("auth_failed", ACCOUNT_LOGIN_REMOVED_MESSAGE);
}

export async function loginBigmodelCodingPlan(
  options: LoginBigmodelCodingPlanOptions = {},
): Promise<LoginBigmodelCodingPlanResult> {
  return {
    ...(await loginZCodeCli({ ...options, providerId: "bigmodel" })),
    providerId: "bigmodel",
  };
}

export async function configureCodingPlanApiKey(
  _options: ConfigureCodingPlanApiKeyOptions,
): Promise<ConfigureCodingPlanApiKeyResult> {
  throw new ZCodeCliLoginError("config_update_failed", ACCOUNT_LOGIN_REMOVED_MESSAGE);
}

export async function logoutZCodeCli(
  options: LogoutZCodeCliOptions = {},
): Promise<LogoutZCodeCliResult> {
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env: options.env });
  // 账号 identity / dynamic API key 的键位机器已随账号族删除；
  // 登出只保留对共享凭据簿历史键位的清理，保证旧凭据不残留。
  const keys = Object.values(SHARED_ZCODE_CREDENTIAL_KEYS);
  const current = await credentialStore.loadMany(keys);
  await credentialStore.deleteIfValues(
    Object.fromEntries(
      Object.entries(current).flatMap(([key, value]) => (value === null ? [] : [[key, value]])),
    ),
  );
  return {
    credentialsPath: credentialStore.filePath,
  };
}
