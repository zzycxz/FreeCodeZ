/* eslint-disable max-lines -- host process 服务注册和启动装配需要集中维护，拆散后会更难追踪依赖注入顺序 */
// Node.js service implementations — NOT safe to import in browser code
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  createNodeProviderRuntimePathEnv,
  NodeModelSelectionConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
} from "@zcode/provider-node";
import { getAppConfigDir as resolveAppConfigDir } from "./paths.js";
import {
  buildLocalMediaPreviewUrl,
  isProviderProvisioningAccountCredentialKey,
  type ProviderProvisioningTrigger,
} from "@zcode/shared";

export {
  materializeZCodeBuiltinProviderConfig,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";

export { createFileService } from "./file/fileService.js";
export {
  attributeHostProcessTree,
  createProcessResourceSampler,
  createProcessResourceTableReader,
  type HostResourceUsageAgent,
  type ProcessResourceSample,
  type ProcessResourceSampler,
} from "./process/processResourceSampler.js";
export { createMediaPreviewService } from "./media-preview/mediaPreview.js";
export type { CreateFileServiceOptions } from "./file/fileService.js";
export {
  defaultWorkspaceFileSearchFilter,
  type WorkspaceFileSearchDecision,
  type WorkspaceFileSearchEntry,
  type WorkspaceFileSearchFilter,
} from "./file/workspaceFileMentionFilter.js";
export {
  createFsFaultInjector,
  getProcessFsFaultInjector,
  maybeThrowInjectedFsFault,
  parseFsFaultRulesFromEnvValue,
  resetProcessFsFaultInjectorForTests,
  setFsFaultInjectorForTests,
  ZCODE_E2E_FS_FAULTS_ALLOW_ENV,
  ZCODE_E2E_FS_FAULTS_ENV,
} from "./fs/fsFaultInjection.js";
export type {
  FsFaultCheckInput,
  FsFaultHit,
  FsFaultInjector,
  FsFaultOperation,
  FsFaultRuleConfig,
  InjectedFsFaultError,
} from "./fs/fsFaultInjection.js";
export {
  setDataBaseDir,
  getDataBaseDir,
  getZCodeDataRootDir,
  getConversationWorkspaceDir,
  getAppConfigDir,
  getExportLogStageDir,
  getExportLogDir,
  getFeedbackRootDir,
  getFeedbackAttachmentDir,
  getFeedbackLogArchiveDir,
  getGitCheckpointIndexRootDir,
  copyDataDirectory,
  validateDataBaseDirTarget,
  ZCODE_WINDOWS_APP_INSTALL_DIR_ENV,
} from "./paths.js";
export { createGitService } from "./git/gitService.js";
export { GitCommitMessageGenerator } from "./git/gitCommitMessageGenerator.js";
export { createGitCheckpointService } from "./git/gitCheckpointService.js";
export { createSystemService } from "./system/systemService.js";
export { listSSHConfigAliasesFromLocalConfig } from "./system/sshConfigAlias.js";
export { createTerminalService } from "./terminal/terminalService.js";
export {
  createSettingService,
  createSettingServiceWithMigrations,
} from "./setting/settingService.js";
export { createCredentialService } from "./credential/credentialService.js";
// Bots / Bot Channels（channel "bots"）：服务工厂 + 五渠道适配器 + 三渠道 runtime。
export { createBotsService } from "./bots/botsService.js";
export type {
  CreateBotsServiceOptions,
  BotRuntimeFactoryContext,
  BotRuntimeHandle,
} from "./bots/botsService.js";
export {
  createWebhookBotProvider,
  verifyWebhookSecret,
  postWebhookWithRetry,
  WEBHOOK_SECRET_HEADER_NAME,
} from "./bots/providers/webhookProvider.js";
export { createTelegramBotProvider } from "./bots/providers/telegramProvider.js";
export { createWeixinBotProvider } from "./bots/providers/weixinProvider.js";
export {
  createFeishuBotProvider,
  beginFeishuAccountsRegistration,
  pollFeishuAccountsRegistration,
} from "./bots/providers/feishuProvider.js";
export { createFeishuStreamingSender } from "./bots/providers/feishuStreaming.js";
export { createTelegramRuntime } from "./bots/runtimes/telegramRuntime.js";
export { createWeixinRuntime } from "./bots/runtimes/weixinRuntime.js";
export { createFeishuRuntime } from "./bots/runtimes/feishuRuntime.js";
export { createBroadcastService } from "./broadcast/broadcastService.js";
export { createZCodeAgentService } from "./zcode-agent/zcodeAgentService.js";
export { createZCodeTaskServiceAdapter } from "./zcode-agent/zcodeTaskServiceAdapter.js";
export { createZCodeSessionService } from "./zcode-session/zcodeSessionService.js";
export {
  resolveDefaultZCodeAgentCommand,
  ZCodeAgentProcessManager,
} from "./zcode-agent/zcodeAgentProcessManager.js";
export type {
  ZCodeAgentCommand,
  ZCodeAgentCommandResolver,
  ZCodeAgentCommandResolverContext,
  ZCodeAgentProcessManagerOptions,
} from "./zcode-agent/zcodeAgentProcessManager.js";
export { ZCodeProtocolClient } from "./zcode-agent/zcodeProtocolClient.js";
export type { ZCodeProtocolTransport } from "./zcode-agent/zcodeProtocolTransport.js";
export { ZCodeStdioTransport } from "./zcode-agent/zcodeStdioTransport.js";
export {
  getZCodeStdioTapDevLogDir,
  readZCodeStdioTapDevState,
  setZCodeStdioTapDevEnabled,
} from "./zcode-agent/zcodeStdioTapDevConfig.js";
export type { ZCodeStdioTapDevState } from "@zcode/shared";
export { createFileWatcherService } from "./fileWatcher/fileWatcherService.js";
export { ensureDeviceMid } from "./device/deviceMid.js";
export type { EnsureDeviceMidOptions } from "./device/deviceMid.js";
// FreeCodeZ fork(P3 §3.3):数仓事件核已删(物理删除);导出面以本地 no-op 保留。
export function createTelemetryCore(..._a: unknown[]): { reportEvent: () => Promise<void>; flushPendingReports: () => Promise<void> } & Record<string, any> {
  return { reportEvent: async () => {}, flushPendingReports: async () => {} } as never;
}
export async function ensureTelemetryDeviceMid(..._a: unknown[]): Promise<string | null> {
  return null;
}
export type EnsureTelemetryDeviceMidOptions = Record<string, unknown>;
export { importLegacyPersonalProviderConfig } from "./model-provider/legacyPersonalProviderConfigImporter.js";
export {
  createProviderConfigRuntime,
  ProviderConfigRuntime,
} from "./model-provider/providerConfigRuntime.js";
export type { ProviderConfigRuntimeOptions } from "./model-provider/providerConfigRuntime.js";
export {
  createProviderRuntime,
  createProviderRuntimeFromConfigRuntime,
  ProviderRuntime,
} from "./model-provider/providerRuntime.js";
export type {
  ProviderRuntimeDependencies,
  ProviderRuntimeOptions,
} from "./model-provider/providerRuntime.js";
export {
  createProviderProvisioningSource,
  listProviderProvisioningCredentialKeys,
  resolveCredentialFilePath,
  type ProviderProvisioningSource,
  type ProviderProvisioningSourceOptions,
} from "./model-provider/providerProvisioningSource.js";
export {
  createProviderProvisioningTarget,
  type ProviderProvisioningTargetOptions,
} from "./model-provider/providerProvisioningTarget.js";
export {
  createModelSelectionService,
  createProviderSettingsService,
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
export { createUsageStatsService } from "./usage-stats/usageStatsService.js";
// Storage：service 与 adapters 工厂；desktop host 负责组装（Worker runner 在 desktop 包内）
export { createStorageService } from "./storage/app/storageService.js";
export type { IStorageService } from "./storage/contract.js";
export type {
  FsCleanerPort as StorageFsCleanerPort,
  RootsResolverPort as StorageRootsResolverPort,
  ScanRunnerPort as StorageScanRunnerPort,
  StorageScanProgress,
  StorageScanRunRequest,
} from "./storage/app/ports.js";
export { createFsStorageCleaner } from "./storage/adapters/fsCleaner.js";
export {
  createStorageRootsResolver,
  resolveStorageRoots,
} from "./storage/adapters/rootsResolver.js";
export { createFsVolumeProbe } from "./storage/adapters/volumeProbe.js";
export { runStorageScan } from "./storage/adapters/inProcessScanRunner.js";
export { createClientConfigService } from "./client-config/clientConfigService.js";
export { createClientScenesService } from "./client-scenes/clientScenesService.js";
export { createSkillsService } from "./skills/skillsService.js";
export { createSkillSyncService } from "./skill-sync/skillSyncService.js";
export { createMcpSyncService } from "./mcp-sync/mcpSyncService.js";
export { createPluginSyncService } from "./plugin-sync/pluginSyncService.js";
export { createPluginsService } from "./plugins/pluginsService.js";
export { createPluginManagementService } from "./plugins/pluginManagementService.js";
export { createSubagentsService } from "./subagents/subagentsService.js";
export { createCommandsService } from "./commands/commandsService.js";
export { createHooksService } from "./hooks/hooksService.js";
export { createMemoryService } from "./memory/memoryService.js";
export { createSettingsSyncService } from "./settings-sync/settingsSyncService.js";
export { createFeedbackDiagnosticArchive } from "./feedback/feedbackLogArchive.js";
export { createFeedbackService } from "./feedback/feedbackService.js";
export type { CreateFeedbackServiceOptions } from "./feedback/feedbackService.js";
export { createLocalPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransferService.js";
export { createNodeApiClient, NodeApiClient } from "./providers/api/nodeApiClient.js";
export {
  createHostApiNetworkTransport,
  type HostApiNetworkTransport,
} from "./providers/api/nodeApiNetwork.js";
export {
  buildRuntimeProcessEnvPatch,
  captureLoginShellEnvSnapshot,
  normalizeRuntimeProcessEnv,
  prepareRuntimeProcessEnvPatch,
} from "./runtime-tools/runtimeCommandEnv.js";

// 定时任务管理与 scheduler 共用同一套 node-only 存储和 cron 语义。
export {
  AutomationRepo,
  DISPATCH_RETRY_BASE_MS,
  DISPATCH_RETRY_CAP_MS,
  DISPATCH_MAX_ATTEMPTS,
  CLAIM_STALE_MS,
  computeRetryAt,
} from "./session/automationRepo.js";
export { AutomationService, InvalidCronExprError } from "./session/automationService.js";
// host 域终态回填 files_changed 复用现有 task diff 汇总。
export { buildTaskChangeSummary } from "./session/taskChangeSummary.js";
export { createServiceLogger } from "./logger/serviceLogger.js";
export {
  computeAutomationNextRunAt,
  computeNextRunAt,
  computeScheduleRuleNextRunAt,
  isOneShotAutomation,
  isValidCronExpr,
} from "./session/automationCron.js";

import { ServiceCollection } from "./collection.js";
import { IFileService } from "./file/file.js";
import { IMediaPreviewService } from "./media-preview/mediaPreview.js";
import { IGitService } from "./git/git.js";
import { IGitCheckpointService } from "./git/gitCheckpoint.js";
import { ISystemService } from "./system/system.js";
import { ITerminalService } from "./terminal/terminal.js";
import { ISettingService } from "./setting/setting.js";
import { IOnboardingRecordService } from "./onboarding/onboardingRecord.js";
import { ICredentialService } from "./credential/credential.js";
import { IBroadcastService } from "./broadcast/broadcast.js";
import { IBotsService } from "./bots/bots.js";
import { createBotsService } from "./bots/botsService.js";
import type { RemoteWorkspaceGate } from "./bots/inboundPipeline.js";
import { createWebhookBotProvider } from "./bots/providers/webhookProvider.js";
import { createTelegramBotProvider } from "./bots/providers/telegramProvider.js";
import { createWeixinBotProvider } from "./bots/providers/weixinProvider.js";
import { createFeishuBotProvider } from "./bots/providers/feishuProvider.js";
import { createTelegramRuntime } from "./bots/runtimes/telegramRuntime.js";
import { createWeixinRuntime } from "./bots/runtimes/weixinRuntime.js";
import { createFeishuRuntime } from "./bots/runtimes/feishuRuntime.js";
import { IZCodeTaskService } from "./session/zcodeTaskService.js";
import { IZCodeAgentService } from "./zcode-agent/zcodeAgent.js";
import { IZCodeSessionService } from "./zcode-session/zcodeSession.js";
import { IFileWatcherService } from "./fileWatcher/fileWatcher.js";
import { IUsageStatsService } from "./usage-stats/usageStats.js";
import { IClientScenesService } from "./client-scenes/clientScenes.js";
import { ISkillsService } from "./skills/skills.js";
import { ISkillSyncService } from "./skill-sync/skillSync.js";
import { IMcpSyncService } from "./mcp-sync/mcpSync.js";
import { IPluginSyncService } from "./plugin-sync/pluginSync.js";
import { IPluginsService } from "./plugins/plugins.js";
import { IPluginManagementService } from "./plugins/pluginManagement.js";
import { ISubagentsService } from "./subagents/subagents.js";
import { ICommandsService } from "./commands/commands.js";
import { IHooksService } from "./hooks/hooks.js";
import { IMemoryService } from "./memory/memory.js";
import { ISettingsSyncService } from "./settings-sync/settingsSync.js";
import { IFeedbackService } from "./feedback/feedback.js";
import { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
import { createFileService } from "./file/fileService.js";
import { createMediaPreviewService } from "./media-preview/mediaPreview.js";
import type { WorkspaceFileSearchFilter } from "./file/workspaceFileMentionFilter.js";
import { createGitService } from "./git/gitService.js";
import { GitCommitMessageGenerator } from "./git/gitCommitMessageGenerator.js";
import { createGitCheckpointService } from "./git/gitCheckpointService.js";
import { createSystemService } from "./system/systemService.js";
import { createTerminalService } from "./terminal/terminalService.js";
import { createSettingServiceWithMigrations } from "./setting/settingService.js";
import { createOnboardingRecordService } from "./onboarding/onboardingRecordService.js";
import { createObservableSettingService } from "./setting/observableSettingService.js";
import { createCredentialService } from "./credential/credentialService.js";
import { createBroadcastService } from "./broadcast/broadcastService.js";
import { createZCodeAgentService } from "./zcode-agent/zcodeAgentService.js";
import type { ZCodeAgentCommandResolver } from "./zcode-agent/zcodeAgentProcessManager.js";
import { buildAgentTelemetrySpawnEnv } from "./zcode-agent/agentTelemetryEnv.js";
import { resolveZCodeAgentPresentationSurface } from "./zcode-agent/zcodeAgentPresentationSurface.js";
import { createZCodeTaskServiceAdapter } from "./zcode-agent/zcodeTaskServiceAdapter.js";
import { createZCodeSessionService } from "./zcode-session/zcodeSessionService.js";
import { createZCodeTaskIndexSyncer } from "./zcode-agent/zcodeTaskIndexSyncer.js";
import { TaskIndexRepo } from "./session/taskIndexRepo.js";
import type { SessionMessageSendRequested } from "#src/session/sessionMailbox.js";
import { createFileWatcherService } from "./fileWatcher/fileWatcherService.js";
import { readLegacyZCodeConfigProviders } from "./model-provider/legacyZCodeConfigProviderReader.js";
import { createProviderConfigRuntime } from "./model-provider/providerConfigRuntime.js";
import {
  createProviderRuntimeFromConfigRuntime,
  type ProviderRuntime,
} from "./model-provider/providerRuntime.js";
import {
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
import { createProviderSettingsConnectivityTester } from "./model-provider/providerSettingsConnectivity.js";
import {
  createProviderProvisioningSource,
  listProviderProvisioningCredentialKeys,
  PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS,
  resolveCredentialFilePath,
  type ProviderProvisioningSource,
} from "./model-provider/providerProvisioningSource.js";
import { createProviderProvisioningTarget } from "./model-provider/providerProvisioningTarget.js";
import { IProviderProvisioningTargetService } from "./model-provider/providerProvisioning.js";
import { resolveClientConfigPlatform } from "./runtime-tools/clientPlatform.js";
import { createUsageStatsService } from "./usage-stats/usageStatsService.js";
import { createClientConfigService } from "./client-config/clientConfigService.js";
import { IClientConfigService } from "./client-config/clientConfig.js";
import { createClientScenesService } from "./client-scenes/clientScenesService.js";
import { createSkillsService } from "./skills/skillsService.js";
import { createSkillSyncService } from "./skill-sync/skillSyncService.js";
import { createMcpSyncService } from "./mcp-sync/mcpSyncService.js";
import { createPluginSyncService } from "./plugin-sync/pluginSyncService.js";
import { createPluginsService } from "./plugins/pluginsService.js";
import { createPluginManagementService } from "./plugins/pluginManagementService.js";
import { createSubagentsService } from "./subagents/subagentsService.js";
import { createCommandsService } from "./commands/commandsService.js";
import { createHooksService } from "./hooks/hooksService.js";
import { createMemoryService } from "./memory/memoryService.js";
import { createSettingsSyncService } from "./settings-sync/settingsSyncService.js";
import {
  createFeedbackService,
  type CreateFeedbackServiceOptions,
} from "./feedback/feedbackService.js";
import { createLocalPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransferService.js";
import { createNodeApiClient } from "./providers/api/nodeApiClient.js";
import {
  createHostApiNetworkTransport,
  type HostApiNetworkTransport,
} from "./providers/api/nodeApiNetwork.js";
import type {
  RuntimeProcessLifecycleReporter,
  RuntimeTaskReporter,
} from "#src/process/runtimeProcessLifecycle.js";
import { initializeRuntimeProcessEnv } from "./runtime-tools/runtimeCommandEnv.js";
import {
  buildAgentEndpointOriginEnv,
  buildAgentRuntimeEnv,
} from "./runtime-tools/agentProxyEnv.js";
import { ensureAppCaCert } from "./runtime-tools/appCaCert.js";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import {
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  resolveSafeEndpointHostname,
  formatLogPrefix,
  isCredentialDecryptError,
  BIGMODEL_PROVIDER_ID,
  type ProviderFamilyDomain,
  type ServiceAuthorityMode,
  resolveRuntimeZCodeEndpointOrigin,
  type BrowserBackendDescriptor,
  type BrowserClientMode,
  type BrowserCommand,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  ZAI_PROVIDER_ID,
  resolveDynamicWorkflowClientConfig,
  ZCODE_VERSION,
  ZCODE_ENV,
  buildRuntimeZCodeApiUrl,
} from "@zcode/shared";
import {
  getCapturedZCodeAgentTelemetryEnv,
  FREECODEZ_CUA_ACTIONS_ENABLED_ENV,
  FREECODEZ_CUA_CONTROL_ENABLED_ENV,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
} from "@zcode/shared/runtime-env";

interface ServiceWithDisposeAll {
  disposeAll: () => void;
}

interface ServiceWithDisposeAllAndWait {
  disposeAllAndWait: () => Promise<void>;
}

function hasDisposeAll(instance: unknown): instance is ServiceWithDisposeAll {
  return (
    typeof instance === "object" &&
    instance !== null &&
    "disposeAll" in instance &&
    typeof (instance as { disposeAll?: unknown }).disposeAll === "function"
  );
}

function hasDisposeAllAndWait(instance: unknown): instance is ServiceWithDisposeAllAndWait {
  return (
    typeof instance === "object" &&
    instance !== null &&
    typeof (instance as { disposeAllAndWait?: unknown }).disposeAllAndWait === "function"
  );
}

const providerRuntimes = new WeakMap<ServiceCollection, ProviderRuntime>();
const providerProvisioningSources = new WeakMap<ServiceCollection, ProviderProvisioningSource>();
const providerProvisioningTriggerDisposers = new WeakMap<
  ServiceCollection,
  readonly (() => void)[]
>();
// TaskIndexRepo / OffPeakTaskRepo 等各自持有 tasks-index.sqlite 的连接句柄；
// dispose 链必须统一关闭：Windows 上句柄悬着会让宿主回收后临时目录 rm 撞 EBUSY
// （stdioDesktopPresentationSurface 单测稳定复现），Linux 的 unlink-while-open 语义掩盖了泄漏。
// 与其它侧表一样按 ServiceCollection 登记并在 dispose 时统一 close。
const sharedSqliteRepos = new WeakMap<ServiceCollection, ReadonlyArray<{ close(): void }>>();

/** Local Host 进程内的 Provisioning Source；不会把凭据通过通用 RPC 暴露给 Renderer。 */
export function getProviderProvisioningSource(
  services: ServiceCollection,
): ProviderProvisioningSource | undefined {
  return providerProvisioningSources.get(services);
}

const managedHostApiNetworkTransports = new WeakMap<ServiceCollection, HostApiNetworkTransport>();

export function registerHostApiNetworkTransportForDispose(
  services: ServiceCollection,
  transport: HostApiNetworkTransport,
): void {
  managedHostApiNetworkTransports.set(services, transport);
}

/**
 * 创建包含所有本地服务的 ServiceCollection
 *
 * @param options.parentPort - Electron host process 的 parentPort，
 *        用于 BroadcastService 跨窗口中转。传 null 则广播为空操作。
 */
export function createLocalServices(options: {
  parentPort?: Parameters<typeof createBroadcastService>[0];
  /** Host 装配层注入的设置权威；与网络 transport 必须来自同一 Window Host 生命周期。 */
  settingService?: ISettingService;
  /** 与注入的本地 Setting 共用写队列；外部远端 Setting 不传，由其权威 Host 完成迁移。 */
  prepareLegacyAccountConnections?: ReturnType<
    typeof createSettingServiceWithMigrations
  >["prepareLegacyAccountConnections"];
  /** 注入后由 ServiceCollection 接管释放，并供 Host 其它 app-managed 下载复用。 */
  hostApiNetworkTransport?: HostApiNetworkTransport;
  /** Desktop Host 请求 Main 登记 Agent 已授权的精确本地视频路径。 */
  authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  feedback?: Partial<
    Omit<CreateFeedbackServiceOptions, "apiClient" | "credentialService">
  >;
  processLifecycleReporter?: RuntimeProcessLifecycleReporter;
  taskRuntimeReporter?: RuntimeTaskReporter;
  /** workspace 文件搜索默认使用内置过滤器；后续规则来源只需在 Host 装配时注入最终实现。 */
  workspaceFileSearchFilter?: WorkspaceFileSearchFilter;
  forwardSessionMessageSendRequested?: (
    request: SessionMessageSendRequested,
  ) => Promise<void> | void;
  /** desktop local host 在 manual run 落库后直接派发，不经过 scheduler 正常路径。 */
  onAutomationManualRunRequested?: (params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }) => Promise<void>;
  /** 闲时任务翻 schedulable 后请求宿主立即唤醒 scheduler（desktop host 注入 parentPort 转发）。 */
  onOffPeakSchedulerWakeRequested?: () => void;
  // 注入点：默认 resolver 已能覆盖 dev/桌面/SSH 远端三类形态；
  // 测试或特殊宿主想强制走自定义 binary/参数时从这里注入。
  zcodeAgentCommandResolver?: ZCodeAgentCommandResolver;
  /** Desktop Main 提前异步采集的本机 runtime 环境；Local Host 注入后不再同步启动 login shell。 */
  runtimeProcessEnvPatch?: Record<string, string>;
  /** 本地桌面上次 workspace 缺失时，仅用于 Agent 子进程 spawn.cwd 兜底。 */
  zcodeAgentSpawnFallbackCwd?: string;
  /** desktop-attached remote server 从 Desktop Host 收到的一次性 Agent 网络配置。 */
  remoteAgentNetwork?: {
    httpProxy?: string;
    noProxy?: string;
  };
  /** 所属 Environment 的 ZCode Built-in Provider Config 物理路径。 */
  zcodeBuiltinProviderConfigFilePath: string;
  /** HTTP Server 只有在调用方明确配置认证时才暴露跨 Environment Provisioning target。 */
  providerProvisioningTargetEnabled?: boolean;
  /** Desktop Host 私有通知；只在 Source 成功持久化后请求 Main 调度远端镜像。 */
  onProviderProvisioningSourceChanged?: (
    trigger: Exclude<ProviderProvisioningTrigger, "environment-online">,
  ) => void;
  serviceAuthorityMode?: ServiceAuthorityMode;
  agentRuntimeContext?: {
    getDeviceMid?: () => string | undefined;
    runtimeSurface?: "desktop_local_host" | "remote_workspace_host";
  };
  /** browser-use 执行桥（host→main WebContentsView+CDP）；desktop host 注入，缺省则 browser 不可用。 */
  browserControlExecutor?: {
    list(input: {
      requestId: string;
      sessionId: string;
      turnId?: string;
      workspaceKey: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
      clientMode: BrowserClientMode;
      sessionContext: "live" | "cached";
    }): Promise<BrowserBackendDescriptor[]>;
    execute(input: {
      requestId: string;
      browserId?: string;
      browserGeneration?: number;
      sessionId: string;
      turnId?: string;
      workspaceKey: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
      clientMode: BrowserClientMode;
      sessionContext: "live" | "cached";
      command: BrowserCommand;
    }): Promise<{ ok: boolean; [k: string]: unknown }>;
  };
  /** bot /reconnect 与远端拦截的 RemoteWorkspaceGate（desktop host 注入真实远程连接态；缺省视为远端不可用）。 */
  remoteWorkspaceService?: RemoteWorkspaceGate;
}): ServiceCollection {
  const isDesktopAttachedRemote = options?.serviceAuthorityMode === "desktop-attached-remote";
  // host / remote server 以前直接沿用当前进程环境启动后续服务。
  // GUI 启动的 desktop、SSH/WSL/Docker 拉起的 remote server 往往拿不到用户 login shell 里的 PATH，
  // 导致 bun 这类只在 shell profile 里追加的命令在 ZCode Agent/终端里不可见。
  // 这里在所有本地服务启动前统一修正运行时环境，并顺带把内置 rg 注入 PATH，
  // 让 ZCode Agent、终端、认证 runtime 共用同一套命令解析结果。
  initializeRuntimeProcessEnv(options?.runtimeProcessEnvPatch);

  const desktopContextPromptEnabledRaw =
    process.env[ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV]?.trim();
  const desktopContextPromptEnabled =
    desktopContextPromptEnabledRaw === "1"
      ? true
      : desktopContextPromptEnabledRaw === "0"
        ? false
        : undefined;

  // app 自签 CA：首次启动生成一份根 CA（幂等），供 agent 子进程经 NODE_EXTRA_CA_CERTS 信任、
  // 出口代理用其私钥重签。生成失败不应阻断启动（例如只读文件系统），仅记录日志后继续。
  try {
    ensureAppCaCert();
  } catch (error) {
    console.error(formatLogPrefix("appCaCert", process.pid), "ensure app CA cert failed:", error);
  }

  const localSettings = options?.settingService ? null : createSettingServiceWithMigrations();
  const settingService = createObservableSettingService(
    options?.settingService ?? localSettings!.service,
  );
  const resolveCurrentZCodeEndpointOrigin = async () =>
    resolveRuntimeZCodeEndpointOrigin(process.env, {
      overrideOrigin: (await settingService.get()).zcodeEndpointOrigin,
    });
  const provisioningOAuthKeys = new Set<string>(PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS);
  const credentialService = createCredentialService({
    onDidMutate: ({ key }) => {
      if (provisioningOAuthKeys.has(key) || isProviderProvisioningAccountCredentialKey(key)) {
        options.onProviderProvisioningSourceChanged?.("credential");
      }
    },
  });
  // FreeCodeZ fork(P2 §4.9):启动时一次性清理登录链遗留的死键。旧安装升级到 FreeCodeZ 后
  // credentials.json 里可能残留 oauth:* / JWT / 归因键;web-remote-control:* 是手机远控
  // 的独立凭据,明确保留。凭据服务无 list 接口,改为直读仓库文件判断后逐键删除;
  // 失败只吞掉,不阻断启动(best-effort 清理)。
  void (async () => {
    try {
      const credentialRepo = await import("#src/credential/legacyCleanupStore.js").then((m) =>
        m.createLegacyCleanupCredentialStore(process.env),
      );
      const legacy = await credentialRepo.loadMany([
        "zcodejwttoken",
        "oauth:active_provider",
        "oauth:login_attribution",
      ]);
      const zaiTokens = await credentialRepo.loadMany([
        "oauth:zai:access_token",
        "oauth:zai:refresh_token",
        "oauth:zai:user_info",
        "oauth:bigmodel:access_token",
        "oauth:bigmodel:refresh_token",
        "oauth:bigmodel:user_info",
      ]);
      const present = [...Object.entries(legacy), ...Object.entries(zaiTokens)]
        .filter(([, value]) => value !== null)
        .map(([key]) => key);
      await Promise.all(present.map((key) => credentialRepo.delete(key)));
    } catch {
      // 独立环境(无凭据仓库)或读取失败:静默跳过。
    }
  })();
  // FreeCodeZ fork:OAuth/账号 provider/官方 MCP 链已整删(规格书 P2 §4.5)——
  // 无凭据仓库、无 401 登出、无账号事实源;personal provider 与内置目录照常。
  const broadcastService = createBroadcastService(options?.parentPort ?? null);
  const gitCheckpointService = createGitCheckpointService();
  const hostApiNetworkTransport =
    options?.hostApiNetworkTransport ??
    createHostApiNetworkTransport(async () => {
      const settings = await settingService.get();
      return {
        httpProxy: settings.httpProxy,
        noProxy: settings.httpProxyNoProxy,
        caCertPath: settings.httpProxyCaCertPath,
      };
    });
  const apiClient = createNodeApiClient({
    fetchImpl: hostApiNetworkTransport.fetch,
    resolveZCodeEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
  });
  const systemService = createSystemService();
  // onboarding 完成记录：FreeCodeZ 无登录态,userId 恒 null。
  const onboardingRecordService = createOnboardingRecordService({
    loadUserId: async () => null,
  });
  const providerConfigLog = createServiceLogger("provider-config");
  const providerConfigRuntime = createProviderConfigRuntime({
    zcodeBuiltinFilePath: options.zcodeBuiltinProviderConfigFilePath,
    onPersonalConfigRecovery: (event) => {
      providerConfigLog.warn(
        undefined,
        "Personal Provider Config 加载失败，已保留磁盘状态并以内存空配置降级",
        {
          error: event.error,
        },
      );
    },
    onPersonalConfigPollingError: (error) => {
      // 轮询错误只在进入失败状态时回调一次；下一轮仍会自行重试，避免持续故障刷盘。
      providerConfigLog.warn(undefined, "Personal Provider Config 轮询暂时失败，将继续重试", {
        error,
      });
    },
    // 已发布 config.json 保存的是 ZCode 用户配置；清理第三方 ACP 不能移除这条升级路径。
    // Repository 仅在新 Personal 配置不存在时导入，并保留旧文件以便回滚。
    readLegacyProviders: () => readLegacyZCodeConfigProviders(),
  });
  const modelSelectionConfiguredDefaultSource = new NodeModelSelectionConfigRepository({
    personalRepository: providerConfigRuntime.personalRepository,
  });
  const providerProvisioningSource = createProviderProvisioningSource({
    personalRepository: providerConfigRuntime.personalRepository,
    settingService,
    credentialFilePath: resolveCredentialFilePath(resolveAppConfigDir()),
    personalConfigFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
  });
  const providerProvisioningDisposers = [
    providerConfigRuntime.configService.onDidChange((reason) => {
      // 每个 Window Host 都会轮询同一文件；只把本进程成功提交的 updated
      // 作为同步触发，避免其它 Host 的 poll-changed 把一次保存重复计入多个代际。
      if (reason === "personal:updated") {
        options.onProviderProvisioningSourceChanged?.("personal-config");
      }
    }),
  ];
  let providerConnectivityAgentService:
    | Pick<IZCodeAgentService, "testModelConnectivity" | "probeProviderAccess" | "listRemoteModels">
    | undefined;
  const providerRuntime = createProviderRuntimeFromConfigRuntime({
    configRuntime: providerConfigRuntime,
    modelSelectionConfiguredDefaultSource,
    disposeModelSelectionConfiguredDefaultSource: () =>
      modelSelectionConfiguredDefaultSource.dispose(),
    testConnectivity: createProviderSettingsConnectivityTester({
      testModelConnectivity: async (input) => {
        if (!providerConnectivityAgentService) {
          throw new Error("Agent Service 尚未完成模型连通性测试装配");
        }
        return providerConnectivityAgentService.testModelConnectivity(input);
      },
    }),
    // 接入探测/模型发现（D-P1.3）：走 agent 管理面 client，与会话请求共用代理语义。
    accessProber: {
      probeProviderAccess: async (input) => {
        if (!providerConnectivityAgentService) {
          throw new Error("Agent Service 尚未完成接入探测装配");
        }
        return providerConnectivityAgentService.probeProviderAccess(input);
      },
      listRemoteModels: async (input) => {
        if (!providerConnectivityAgentService) {
          throw new Error("Agent Service 尚未完成模型发现装配");
        }
        return providerConnectivityAgentService.listRemoteModels(input);
      },
    },
  });
  // mcpSync/hooks 里引用 zcodeAgentService 的闭包是惰性调用，声明顺序不影响初始化。
  const skillsService = createSkillsService({ isDesktopRuntime: true });
  const mcpSyncService = createMcpSyncService({
    // mcp/list 的 host 消费点收拢到 mcpSync 服务；真实状态检查仍在 agent 进程。
    listMcpServerStatuses: (params) => zcodeAgentService.listMcpServerStatuses(params),
  });
  const pluginSyncService = createPluginSyncService();
  const subagentsService = createSubagentsService({
    isDesktopRuntime: true,
  });
  const commandsService = createCommandsService({ isDesktopRuntime: true });
  const hooksService = createHooksService({
    grantWorkspaceHookTrust: (params) => zcodeAgentService.grantWorkspaceHookTrust(params),
  });
  const memoryService = createMemoryService();
  // 只要当前进程已经装配 Provider Runtime，就由该 Environment 自己的 Selection View
  // 决定执行就绪状态。Desktop-attached remote 也读取远端自己的 Config/Account Facts。
  const modelSelectionReadinessSource = providerRuntime.modelSelection;
  // ===== Computer Use Helper lifecycle 层（port 自 feat）=====
  const zcodeAgentService = createZCodeAgentService({
    ...(modelSelectionReadinessSource ? { modelSelectionReadinessSource } : {}),
    authorizeLocalMediaPreviewPath: options?.authorizeLocalMediaPreviewPath,
    // 动态工作流灰度：FreeCodeZ fork 无远端 client/configs,接 shared 的 env 解析器
    // (ZCODE_DYNAMIC_WORKFLOW_MODE 可开,默认 disabled)——不再有平台侧远程翻转(规格书 P2 §4.5)。
    resolveDynamicWorkflowClientConfig: async () =>
      resolveDynamicWorkflowClientConfig({ remote: undefined, env: process.env }),
    // 交互会话沙箱全局开关（沙箱规格书 R2）：每次现读高级设置，未显式声明沙箱的
    // 会话（交互直连/远控 replayable/冷恢复）以此为准；automation 链的每任务开关
    // 在 adapter 侧显式传值，不进此回退。平台可用性由执行侧分发器 fail-open 兜底。
    resolveInteractiveSandboxEnabled: async () =>
      (await settingService.get()).sandboxEnabled === true,
    commandResolver: options?.zcodeAgentCommandResolver,
    presentationSurface: resolveZCodeAgentPresentationSurface({
      runtimeSurface: options?.agentRuntimeContext?.runtimeSurface,
      serviceAuthorityMode: options?.serviceAuthorityMode,
      desktopContextPromptEnabled,
    }),
    onAutomationManualRunRequested: options?.onAutomationManualRunRequested,
    // createLocalServices 虽然暴露了 reporter 注入点，旧装配却没有继续传给
    // ZCodeAgentProcessManager，导致 host 永远不向 main 上报 Agent spawn/exit，进程监控器
    // 因而看不到实际运行的 Agent，也无法验证只读到可写升级是否复用同一进程。
    processLifecycleReporter: options?.processLifecycleReporter,
    spawnFallbackCwd: options?.zcodeAgentSpawnFallbackCwd,
    // browser-use：host→main 执行桥透传给 agent service 的 onRequest browserExecute 路由。
    browserControlExecutor: options?.browserControlExecutor,
    // 设置页的 HTTP 代理、No Proxy + 自定义 CA 按 spawn 时读取注入 agent 子进程 env，
    // 覆盖模型 API / MCP / Bash 出口流量并信任用户显式配置的证书；改动后下次启动 agent 生效。
    resolveSpawnEnv: async (context) => {
      const [settings] = await Promise.all([settingService.get(), providerRuntime.start()]);
      // 内置 Subagent 的旧覆盖必须在 CLI 独立读取之前导入，不能等待设置页操作。
      await subagentsService.prepareRuntimeState();
      const agentNetwork =
        isDesktopAttachedRemote && options?.remoteAgentNetwork
          ? options.remoteAgentNetwork
          : {
              httpProxy: settings.httpProxy,
              noProxy: settings.httpProxyNoProxy,
            };
      // FreeCodeZ fork(P3 §3.2):导出链已删,遥测恒为未配置。
      const telemetryConfigured = false;
      // FreeCodeZ fork:无登录态,遥测不再关联用户画像(P3 将整删)。
      const telemetryProfile = null;
      const telemetryDeviceMid = telemetryConfigured
        ? options?.agentRuntimeContext?.getDeviceMid?.()?.trim()
        : undefined;
      // Host 是旧配置迁移的唯一写入者。Agent spawn 前等待初始化完成，避免 Worker
      // 先拿到尚不存在的 provider_config.json 并发布短暂空 Registry。
      await providerConfigRuntime.start();
      return {
        ...buildAgentRuntimeEnv({
          httpProxy: agentNetwork.httpProxy,
          noProxy: agentNetwork.noProxy,
          caCertPath: settings.httpProxyCaCertPath,
        }),
        // 把 host 解析出的权威 origin（含 settings 覆盖）下发给 agent，否则 agent 侧只按
        // env 推导，test env + 自定义端点时两侧信任判定的输入分叉、官方 MCP 整体 fail closed。
        ...buildAgentEndpointOriginEnv(await resolveCurrentZCodeEndpointOrigin()),
        // 电脑控制生效链门（规格书 V1.17）：桌面设置总开关随 spawn 显式下发，
        // bootstrap 据此门控 node_repl computer 桥（fail-closed）。桌面态两态都显式注入
        //（开="1" 关="0"）；headless CLI 不走此注入=无 env=不设门。
        [FREECODEZ_CUA_CONTROL_ENABLED_ENV]: settings.cuaControlEnabled === true ? "1" : "0",
        // 动作层开关（V1.19 P1）：同一管线，语义=总开关开+动作关时「只能看不能动」。
        [FREECODEZ_CUA_ACTIONS_ENABLED_ENV]: settings.cuaActionsEnabled === true ? "1" : "0",
        // FreeCodeZ fork(P3 §3.2):Agent 遥测 spawn env 注入已删(恒空)。
        ...createNodeProviderRuntimePathEnv({
          // Built-in Active 路径按当前 Endpoint 隔离，不能通过同步的固定路径
          // getter 读取；Agent spawn 必须等待本轮 Endpoint Source 完成解析和物化。
          zcodeBuiltinFilePath: await providerConfigRuntime.resolveZCodeBuiltinActiveFilePath(),
          personalFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
        }),
      };
    },
    ...(isDesktopAttachedRemote
      ? { sessionRuntimePreferencesAuthority: "external" as const }
      : {
          sessionRuntimePreferencesAuthority: "local" as const,
          resolveSessionRuntimePreferences: async (scope) => {
            // 预算已统一，不能把可选远端配置作为本地/手机 shared-host 建会话的前置条件。
            const settings = await settingService.get();
            const modelContextBudgetStrategy = DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY;
            return {
              askUserQuestionAutoResolutionEnabled:
                settings.askUserQuestionAutoResolutionEnabled !== false,
              nativeSearchEnhancementsEnabled: settings.nativeSearchEnhancementsEnabled !== false,
              memoryEnabled: settings.memoryEnabled === true,
              modelContextBudgetStrategy,
              // FreeCodeZ fork(P6 §6.2):搜索/视觉偏好随会话透传给 agent 工具。
              searchSummaryMode: settings.searchSummaryMode ?? "on",
              searchSafeSearch: settings.searchSafeSearch ?? "moderate",
              ...(settings.searchCountry ? { searchCountry: settings.searchCountry } : {}),
              ...(settings.visionUnderstandModel
                ? { visionUnderstandModel: settings.visionUnderstandModel }
                : {}),
              // user-execution 只消费 Shell；共享默认策略是统一 result schema 的兼容占位，
              // 不会覆盖 runtime-materialization 阶段已经固定的 strategy。
              ...(scope === "user-execution" && settings.integratedTerminalShell
                ? { integratedTerminalShell: settings.integratedTerminalShell }
                : {}),
            };
          },
        }),
  });
  providerConnectivityAgentService = zcodeAgentService;
  // desktop-continuous UI 直接订阅 zcodeSessionService，绕开 ZCode task adapter 的
  // mapServiceEvent 路径，导致 task_complete 永远不会写回 sqlite，侧边栏 spinner 不停。
  // 在 services 层装配一个共享的 taskIndexRepo + syncer，session 任意入口都会唤醒
  // shadow 订阅，把 runtime 终态收敛进 sqlite。
  const taskIndexRepo = new TaskIndexRepo();
  const zcodeTaskIndexSyncer = createZCodeTaskIndexSyncer({
    agentService: zcodeAgentService,
    taskIndexRepo,
  });
  const zcodeSessionService = createZCodeSessionService({
    agentService: zcodeAgentService,
    taskIndexSyncer: zcodeTaskIndexSyncer,
  });
  const gitCommitMessageGenerator = new GitCommitMessageGenerator({
    currentModelProvider: {
      async readCurrentModel() {
        // Git sidecar 属于目标 Environment；初始模型直接读取同一 Host View，
        // 不再通过临时 Agent workspace state 反推模型与 reasoning。
        return (await providerRuntime.modelSelection.getView()).preferredSelection ?? null;
      },
    },
    textGenerator: {
      async generateText(params) {
        return await zcodeAgentService.generateWorkspaceText({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          selection: params.selection,
          prompt: params.prompt,
          querySource: params.querySource,
        });
      },
    },
    logger: createServiceLogger("git-commit-message"),
  });
  const gitService = createGitService({
    commitMessageGenerator: gitCommitMessageGenerator,
  });
  // task wrapper 由 ZCode task service adapter 提供；核心 session 状态由 ZCode agent server 维护。
  const zcodeTaskService = createZCodeTaskServiceAdapter({
    zcodeAgentService,
    taskIndexRepo,
    taskIndexSyncer: zcodeTaskIndexSyncer,
    settingService,
  });
  // 机器人 / Bot Channels：五渠道适配器 + 三渠道 runtime + 入站/回复管道（channel "bots"）。
  const botsCredentialLoader = (key: string) => credentialService.load(key);
  // /workspace //model 命令的数据源：工作区取 settings 的会话历史∪最近项目，
  // 模型目录取 ModelSelectionFacade 投影（reasoningLevel.values 即推理档位表）。
  const listBotsWorkspaceRefs = async (): Promise<
    Array<{
      label: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remote?: boolean;
    }>
  > => {
    const settings = await settingService.get();
    const seen = new Set<string>();
    const refs: Array<{
      label: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remote?: boolean;
    }> = [];
    const push = (workspacePath: string, workspaceIdentity?: string, remote?: boolean): void => {
      const key = workspaceIdentity?.trim() || workspacePath;
      if (!workspacePath || seen.has(key)) return;
      seen.add(key);
      refs.push({
        label: remote ? (workspaceIdentity || workspacePath) : basename(workspacePath) || workspacePath,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remote ? { remote: true } : {}),
      });
    };
    for (const entry of settings.lastWorkspaceSession ?? []) {
      if (entry.kind === "remote") {
        push(entry.workspacePath, entry.workspaceIdentity, true);
      } else {
        push(entry.workspacePath);
      }
    }
    for (const path of settings.recentProjects ?? []) push(path);
    return refs;
  };
  const listBotsModelCatalog = async (): Promise<
    Array<{
      id: string;
      name: string;
      models: Array<{ id: string; name: string; thoughtLevels?: string[] }>;
    }>
  > => {
    const view = await providerRuntime.modelSelection.getView();
    return view.providers.map((provider) => ({
      id: provider.providerId,
      name: provider.providerName || provider.providerId,
      models: provider.models.map((model) => {
        const levels = model.config?.optionSpecs?.reasoningLevel?.values;
        return {
          id: model.modelId,
          name: model.modelId,
          ...(levels?.length ? { thoughtLevels: [...levels] } : {}),
        };
      }),
    }));
  };
  const botsService = createBotsService({
    credentialService,
    taskService: zcodeTaskService,
    broadcastService,
    settingService,
    listWorkspaceRefs: listBotsWorkspaceRefs,
    listModelCatalog: listBotsModelCatalog,
    resolveModelSelection: async (context, requested) => {
      const candidate = requested ?? context.draftOptions?.modelSelection;
      const view = await providerRuntime.modelSelection.getView(
        candidate ? { selection: candidate } : undefined,
      );
      return {
        effectiveSelection: view.effectiveSelection ?? null,
        ...(view.preferredSelection ? { preferredSelection: view.preferredSelection } : {}),
        ...(view.selectionIssue ? { selectionIssue: view.selectionIssue } : {}),
      };
    },
    // bot /reconnect 与远端拦截（附录B §6-10）：gate 由 desktop host 经 createLocalServices 注入；
    // 其它宿主（server/web）缺省不注入，远端命令按 remoteReconnectUnavailable/未连接文案兜底。
    ...(options?.remoteWorkspaceService
      ? { remoteWorkspaceService: options?.remoteWorkspaceService }
      : {}),
    adapters: [
      createWebhookBotProvider(),
      createTelegramBotProvider({ credentialLoader: botsCredentialLoader }),
      createWeixinBotProvider({ credentialLoader: botsCredentialLoader }),
      createFeishuBotProvider({ credentialLoader: botsCredentialLoader }),
    ],
    createRuntimes: (botsRuntimeContext) => [
      createTelegramRuntime({
        fetchImpl: botsRuntimeContext.fetchImpl,
        apiBase: botsRuntimeContext.apiBaseTelegram,
        configDir: botsRuntimeContext.configDir,
        credentialLoader: botsRuntimeContext.credentialLoader,
        listBots: botsRuntimeContext.listBots,
        readTelegramOffset: botsRuntimeContext.readTelegramOffset,
        writeTelegramOffset: botsRuntimeContext.writeTelegramOffset,
        handleInboundMessage: botsRuntimeContext.handleInboundMessage,
        onStatus: botsRuntimeContext.onStatus,
        logger: botsRuntimeContext.logger,
        now: botsRuntimeContext.now,
      }),
      createWeixinRuntime({
        fetchImpl: botsRuntimeContext.fetchImpl,
        configDir: botsRuntimeContext.configDir,
        credentialLoader: botsRuntimeContext.credentialLoader,
        listBots: botsRuntimeContext.listBots,
        readGetUpdatesBuf: botsRuntimeContext.readGetUpdatesBuf,
        writeGetUpdatesBuf: botsRuntimeContext.writeGetUpdatesBuf,
        handleInboundMessage: botsRuntimeContext.handleInboundMessage,
        onStatus: botsRuntimeContext.onStatus,
        logger: botsRuntimeContext.logger,
        now: botsRuntimeContext.now,
      }),
      createFeishuRuntime({
        configDir: botsRuntimeContext.configDir,
        credentialLoader: botsRuntimeContext.credentialLoader,
        listBots: botsRuntimeContext.listBots,
        handleInboundMessage: botsRuntimeContext.handleInboundMessage,
        onStatus: botsRuntimeContext.onStatus,
        logger: botsRuntimeContext.logger,
        now: botsRuntimeContext.now,
      }),
    ],
  });
  const fileService = createFileService({
    workspaceFileSearchFilter: options?.workspaceFileSearchFilter,
  });
  const mediaPreviewService = createMediaPreviewService({
    fileService,
    authorizeLocalMediaPreviewPath: options?.authorizeLocalMediaPreviewPath,
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
  });
  // 注册链上的懒工厂会各自创建 tasks-index sqlite repo；先收集到本数组，
  // services 集合建好后在 return 前统一登记进 sharedSqliteRepos 侧表
  const sqliteReposToClose: Array<{ close(): void }> = [];
  const services = new ServiceCollection()
    .register(IFileService, fileService)
    .register(IMediaPreviewService, mediaPreviewService)
    .register(IGitService, gitService)
    .register(IGitCheckpointService, gitCheckpointService)
    .register(ISystemService, systemService)
    .register(ITerminalService, createTerminalService({ settingService }))
    .register(ISettingService, settingService)
    .register(IOnboardingRecordService, onboardingRecordService)
    .register(ICredentialService, credentialService)
    .register(IBroadcastService, broadcastService)
    .register(IZCodeTaskService, zcodeTaskService)
    .register(IBotsService, botsService)
    .register(IZCodeAgentService, zcodeAgentService)
    .register(IZCodeSessionService, zcodeSessionService)
    .register(IFileWatcherService, createFileWatcherService())
    .register(
      IUsageStatsService,
      createUsageStatsService({
        apiClient,
        credentialService,
        zcodeAgentService,
      }),
    )
    .register(
      IClientConfigService,
      createClientConfigService({
        apiClient,
        resolveRequestContext: async () => ({
          endpointOrigin: await resolveCurrentZCodeEndpointOrigin(),
          appVersion: ZCODE_VERSION,
          platform: `${process.platform}-${process.arch}`,
        }),
      }),
    )
    // Client Scenes 改随包内置，不再走 apiClient 外联（docs/spec/local-client-scenes.md）。
    .register(IClientScenesService, createClientScenesService())
    .register(ISkillsService, skillsService)
    .register(ISkillSyncService, createSkillSyncService())
    .register(IMcpSyncService, mcpSyncService)
    // 合并 MCP/Plugin Management 服务装配时误删了 plugin-sync 注册，
    // RemoteServiceAccess 仍会请求该频道，导致本地候选枚举超时、远端同步无法开始。
    .register(IPluginSyncService, pluginSyncService)
    .register(IPluginsService, createPluginsService({ isDesktopRuntime: true }))
    // 设置页插件管理薄服务——plugins/* 旧协议词的 host 侧唯一消费点。
    .register(IPluginManagementService, createPluginManagementService({ zcodeAgentService }))
    .register(ISubagentsService, subagentsService)
    .register(ICommandsService, createCommandsService({ isDesktopRuntime: true }))
    .register(
      IHooksService,
      createHooksService({
        grantWorkspaceHookTrust: (params) => zcodeAgentService.grantWorkspaceHookTrust(params),
      }),
    )
    .register(IMemoryService, createMemoryService())
    .register(ISettingsSyncService, createSettingsSyncService({ settingService }))
    .register(
      IFeedbackService,
      createFeedbackService({
        ...options?.feedback,
        apiClient,
        credentialService,
      }),
    )
    .register(IPromptAttachmentTransferService, createLocalPromptAttachmentTransferService());

  registerHostApiNetworkTransportForDispose(services, hostApiNetworkTransport);

  providerRuntimes.set(services, providerRuntime);
  providerProvisioningSources.set(services, providerProvisioningSource);
  providerProvisioningTriggerDisposers.set(services, providerProvisioningDisposers);
  services
    .register(IProviderSettingsService, providerRuntime.providerSettings)
    .register(IModelSelectionService, providerRuntime.modelSelection);
  if (isDesktopAttachedRemote || options.providerProvisioningTargetEnabled === true) {
    services.register(
      IProviderProvisioningTargetService,
      createProviderProvisioningTarget({
        providerRuntime,
        personalRepository: providerConfigRuntime.personalRepository,
        credentialService,
        settingService,
        personalConfigFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
        stateFilePath: join(resolveAppConfigDir(), "runtime", "provider", "provisioning.json"),
        listProvisioningCredentialKeys: () =>
          listProviderProvisioningCredentialKeys(resolveCredentialFilePath(resolveAppConfigDir())),
      }),
    );
  }
  const log = createServiceLogger("provider-runtime");
  void providerRuntime.start().then(
    () => {
      const snapshot = providerRuntime.registryService.getSnapshot()!;
      log.info("Provider Registry 已就绪", {
        configRevision: snapshot.sourceRevisions.config,
        providerCount: snapshot.registry.providers.length,
      });
    },
    (error: unknown) => {
      log.error("Provider 配置事实初始化失败", error);
    },
  );

  // 见 sharedSqliteRepos 声明处注释：登记全部 tasks-index sqlite 句柄，dispose 链统一关闭
  sqliteReposToClose.push(taskIndexRepo);
  sharedSqliteRepos.set(services, sqliteReposToClose);
  return services;
}

export function createTelemetryUserIdLoader(
  credentialService: Pick<ICredentialService, "load">,
): () => Promise<string> {
  const log = createServiceLogger("telemetry-user-id");
  return async () => {
    try {
      const activeProvider = (await credentialService.load("oauth:active_provider"))?.trim() ?? "";
      if (!activeProvider) {
        return "";
      }

      const rawUserInfo = await credentialService.load(`oauth:${activeProvider}:user_info`);
      return readTelemetryOAuthUserId(rawUserInfo);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      // Bugfix: telemetry 只是只读 userId 上报入口，不能抢在 host 登录服务前
      // 对损坏凭据做半套清理；否则会漏掉派生模型 provider key 的 logout 收口。
      log.warn(undefined, "skip telemetry user id: OAuth credential decrypt failed", error);
      return "";
    }
  };
}

/** FreeCodeZ fork(P2 §4.9):登录链已删,授权加载器恒 null。 */
export function createTelemetryAuthorizationLoader(
  _credentialService: Pick<ICredentialService, "load">,
): (userId: string) => Promise<string | null> {
  return async () => null;
}

export function createTelemetryMarketingParamsLoader(
  _credentialService: ICredentialService,
): () => Promise<null> {
  // FreeCodeZ fork:无登录态,渠道归因恒 null(数仓上报本身在 P3 整删)。
  return () => Promise.resolve(null);
}

function readTelemetryOAuthUserId(rawUserInfo: string | null): string {
  if (!rawUserInfo) {
    return "";
  }

  try {
    const parsed = JSON.parse(rawUserInfo) as {
      id?: unknown;
      user_id?: unknown;
    };
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const userId = typeof parsed.user_id === "string" ? parsed.user_id : "";
    return id.trim() || userId.trim();
  } catch {
    return "";
  }
}

export function disposeServiceResources(services: ServiceCollection): void {
  // host process 退出前以前没有统一遍历本地服务做资源回收，
  // terminal/task wrapper 这类会拉起子进程的服务只能等宿主进程自己结束，时序上可能留下短暂残留。
  // 这里集中调用各服务的本地 disposeAll 钩子，把“退出 app = 回收所有托管资源”落成机械动作。
  const disposableServices = [
    services.getOptional(ITerminalService),
    services.getOptional(IZCodeTaskService),
    services.getOptional(IZCodeAgentService),
    services.getOptional(IZCodeSessionService),
    services.getOptional(IFileWatcherService),
  ].filter((service) => service !== undefined);

  for (const service of disposableServices) {
    if (hasDisposeAll(service)) {
      service.disposeAll();
    }
  }

  // 关闭共享 tasks-index sqlite 句柄（Windows 上悬着句柄会让后续目录清理撞 EBUSY）
  for (const repo of sharedSqliteRepos.get(services) ?? []) repo.close();
  sharedSqliteRepos.delete(services);
  providerRuntimes.get(services)?.dispose();
  for (const dispose of providerProvisioningTriggerDisposers.get(services) ?? []) dispose();
  providerProvisioningTriggerDisposers.delete(services);
  providerProvisioningSources.delete(services);
  managedHostApiNetworkTransports.get(services)?.dispose();
}

export async function disposeServiceResourcesAndWait(services: ServiceCollection): Promise<void> {
  // app 关闭时 host 需要等 agent 进程树完成 graceful + force 清理。
  // 旧的同步 dispose 会在 host 退出时丢掉强杀 timer，导致 zcode-cli/app-server 变成孤儿进程。
  const disposableServices = [
    services.getOptional(ITerminalService),
    services.getOptional(IZCodeTaskService),
    services.getOptional(IZCodeAgentService),
    services.getOptional(IZCodeSessionService),
    services.getOptional(IFileWatcherService),
  ].filter((service) => service !== undefined);

  for (const service of disposableServices) {
    if (hasDisposeAllAndWait(service)) {
      await service.disposeAllAndWait();
    } else if (hasDisposeAll(service)) {
      service.disposeAll();
    }
  }

  // 关闭共享 tasks-index sqlite 句柄（同 disposeServiceResources，异步收口路径也要释放）
  for (const repo of sharedSqliteRepos.get(services) ?? []) repo.close();
  sharedSqliteRepos.delete(services);
  providerRuntimes.get(services)?.dispose();
  for (const dispose of providerProvisioningTriggerDisposers.get(services) ?? []) dispose();
  providerProvisioningTriggerDisposers.delete(services);
  providerProvisioningSources.delete(services);
  await managedHostApiNetworkTransports
    .get(services)
    ?.disposeAndWait()
    .catch(() => {});
}
