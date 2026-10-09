/* eslint-disable max-lines -- helper 装配面(addon/安装验签/生命周期/registry/准入判定/config 链)与 broker-server.d.ts 契约一一对应,拆分会把同一 Helper 装配语义散到多处。 */
// FreeCodeZ fork(电脑控制能力补位 B2):helper 装配面真实现(addon 解析、控制协议参数、
// 轮换 marker、生命周期管理器)。mac 专属面(Helper.app 安装/验签、TCC 主体、LaunchServices
// 权限请求)按已接受限制 3 保留签名并 fail-closed,绝不静默降级。
import { constants, accessSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CuaHelperError } from "./broker.js";
import {
  DEV_CUA_HELPER_BUNDLE_ID,
  DEV_HELPER_APP_NAME,
  HELPER_APP_NAME,
  HELPER_BUNDLE_ID,
  HELPER_ENTRY_RELATIVE_PATH,
} from "./broker-helper-constants.js";

export const HELPER_ADDON_ENV = "ZCODE_CUA_HELPER_ADDON";
export const WINDOWS_DEV_CONTROL_PROTOCOL = "zcode-cua-windows-dev/v1";

const UNAVAILABLE = "This Computer Use surface is unavailable in this build.";
const UNAUTHORIZED = "This Computer Use surface is unavailable in this build";

import { resolveExpectedCuaHelperBuildId } from "./producer/helper-build-id.js";
// R19（mac Helper 自研产线）：宿主生命周期与真验签依赖。本模块（broker-server）是
// buildHelperOpenArgs 的单一事实源，经参数注入 product-helper-host 以避免环依赖；
// lipo/codesign 验签实现在 macos/helper-verifier.js（自 host 拆出，max-lines 惯例）。
import { createMacProductHelperHost } from "./macos/product-helper-host.js";
import { createDarwinVerifierDependencies } from "./macos/helper-verifier.js";

function unavailableReject() {
  return Promise.reject(new CuaHelperError(UNAVAILABLE, { code: "not_authorized" }));
}

/**
 * helper 启动参数(I5):`--socket <pipe> --parent-pid <pid>`,dev 可带 --exit-log。
 * R19 全面复查补全两种消费形态：
 * - 直接 spawn 形态（product-helper-host）：spec 只带 socketPath/parentPid/exitLogDir → 纯 helper argv，
 *   入口脚本由 host 自行前置（spawn(exec, [entry, ...本 argv])）；
 * - LaunchServices `open` 形态（node.ts 设置页 standalone 拉起）：spec 带 appPath → 输出
 *   `[-a <app> --args <entry> <helper argv>]`。**entry 必须在场**：可执行体是 node 底座（SEA 废弃），
 *   LaunchServices 不经 host 缺少人前置入口——缺了 node 把 `--socket` 当自身选项 `bad option` 即退
 *   （2026-10-08 真机实证，设置页权限查询 5.1s/次的特征签名）。布局常量 HELPER_ENTRY_RELATIVE_PATH 单源。
 *   （`/usr/bin/open` 的 CLI 形状；exitLogDir/exitLogPath 两种键名都收，前者目录后者文件，helper 侧两态兼容。）
 */
export function buildHelperOpenArgs(spec, launcherPid) {
  const helperArgs = [];
  if (typeof spec?.socketPath === "string" && spec.socketPath) {
    helperArgs.push("--socket", spec.socketPath);
  }
  if (Number.isSafeInteger(launcherPid) && launcherPid > 0) {
    helperArgs.push("--parent-pid", String(launcherPid));
  }
  const exitLog =
    (typeof spec?.exitLogDir === "string" && spec.exitLogDir) ||
    (typeof spec?.exitLogPath === "string" && spec.exitLogPath) ||
    "";
  if (exitLog) {
    helperArgs.push("--exit-log", exitLog);
  }
  if (typeof spec?.appPath === "string" && spec.appPath) {
    return [
      "-a",
      spec.appPath,
      "--args",
      join(spec.appPath, HELPER_ENTRY_RELATIVE_PATH),
      ...helperArgs,
    ];
  }
  return helperArgs;
}

export function isCuaLocalDevelopmentRuntime(env, compiledLocalDevelopmentRuntime) {
  if (compiledLocalDevelopmentRuntime === true) return true;
  const source = env ?? process.env;
  const explicit = source.ZCODE_CUA_DEV_MODE?.trim().toLowerCase();
  return explicit === "1" || explicit === "true" || explicit === "on";
}

/** mac TCC 权限主体身份(Windows 不启用;按限制 3 fail-closed)。 */
export async function resolveHelperPermissionSubjectIdentity(_appPath) {
  throw new CuaHelperError(`${UNAUTHORIZED} (permission subject identity is macOS-only)`, {
    code: "not_authorized",
  });
}

/**
 * 验签依赖默认值：darwin=R19 真实现（lipo/codesign；adhoc 可过 verify，TeamIdentifier 仅
 * env 钉扎时校验）；非 darwin 保持显式 unavailable（该面只有 mac Helper 安装路径会消费）。
 */
export const defaultCuaHelperVerifierDependencies =
  process.platform === "darwin"
    ? createDarwinVerifierDependencies()
    : {
        readExecutableArchs: unavailableReject,
        verifyCodeSignature: unavailableReject,
        verifyTeamIdentifier: unavailableReject,
      };

/**
 * Helper 安装/验签(R13 fail-closed):ensureInstalled 从 bundledAppPath 复制 Helper.app;
 * verifyInstalled 做 bundle id/版本/arch/codesign/TeamIdentifier pin 校验,任一缺失或不符即拒。
 * 校验器依赖可注入(mac 产线注入真实 SecCode 实现);默认依赖在非 mac 构建上显式报 unavailable。
 */
export function createCuaHelperInstaller(options = {}) {
  const env = options.env ?? process.env;
  const dependencies = {
    ...defaultCuaHelperVerifierDependencies,
    ...options.dependencies,
  };
  const variant = env.ZCODE_CUA_HELPER_INSTALL_VARIANT?.trim();
  const appDirName = variant ? DEV_HELPER_APP_NAME : HELPER_APP_NAME;
  const expectedBundleId = variant ? DEV_CUA_HELPER_BUNDLE_ID : HELPER_BUNDLE_ID;
  const installRoot =
    typeof options.installRoot === "string" && options.installRoot
      ? options.installRoot
      : join(homedir(), ".freecodez", "computer-use");

  return {
    async ensureInstalled() {
      const buildId = resolveExpectedCuaHelperBuildId() ?? "";
      const devEscape =
        isCuaLocalDevelopmentRuntime(env) || (env.FREECODEZ_CUA_HELPER_ALLOW_UNSIGNED_LOCAL ?? env.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL) === "1";
      if (!buildId && !devEscape) {
        throw new CuaHelperError(
          "Packaged ZCode is missing its embedded Computer Use Helper build identity; refusing an unpinned Helper install",
          { code: "not_authorized" },
        );
      }
      const bundledAppPath = options.bundledAppPath;
      if (typeof bundledAppPath !== "string" || !bundledAppPath) {
        // dev 逃生口:无内置 Helper.app 且允许未签名本地产物时回退安装目录之外的本地路径。
        if (isCuaLocalDevelopmentRuntime(env) || (env.FREECODEZ_CUA_HELPER_ALLOW_UNSIGNED_LOCAL ?? env.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL) === "1") {
          throw new CuaHelperError(`${UNAVAILABLE} (no bundled Helper app in this build)`, {
            code: "not_authorized",
          });
        }
        throw new CuaHelperError(
          "Packaged ZCode is missing its embedded Computer Use Helper; refusing an unpinned Helper install",
          { code: "not_authorized" },
        );
      }
      const target = join(installRoot, appDirName);
      try {
        await access(join(target, "Contents", "Info.plist"), constants.R_OK);
      } catch {
        // 不在则从内置副本安装(单层目录复制;mac Helper.app 是目录束)。
        await mkdir(target, { recursive: true });
        await copyDirectory(bundledAppPath, target);
        return target;
      }
      // R19 全面复查补：升级新鲜度——已安装副本的 identity.buildId 与期望（编译期钉扎）
      // 漂移即重装。TCC 授权按 bundle id+安装路径持有，重装不清授权；不比对则 app 每次
      // 升级后 Helper 永远停在首装版本（宿主侧方法面/协议随之漂移）。dev 逃生口下不比对
      //（buildId 为空或本地开发形态）。
      const expectedBuildId = (options.expectedBuildId ?? buildId) || "";
      if (expectedBuildId) {
        const identity = await readBundleIdentityManifest(target);
        if (identity?.buildId !== expectedBuildId) {
          await rm(target, { recursive: true, force: true });
          await mkdir(target, { recursive: true });
          await copyDirectory(bundledAppPath, target);
        }
      }
      return target;
    },
    async verifyInstalled(appPath) {
      const manifest = await readBundleIdentityManifest(appPath);
      if (!manifest) {
        throw new CuaHelperError("Computer Use Helper is missing its identity manifest", {
          code: "not_authorized",
        });
      }
      if (manifest.bundleId !== expectedBundleId) {
        throw new CuaHelperError(
          `Computer Use Helper bundle id mismatch: expected ${expectedBundleId}, found ${manifest.bundleId}`,
          { code: "not_authorized" },
        );
      }
      const archs = await dependencies.readExecutableArchs(appPath).catch(() => {
        throw new CuaHelperError(`${UNAUTHORIZED} (arch verification unavailable)`, {
          code: "not_authorized",
        });
      });
      if (!Array.isArray(archs) || archs.length === 0) {
        throw new CuaHelperError("Computer Use Helper has no readable architectures", {
          code: "not_authorized",
        });
      }
      await dependencies.verifyCodeSignature(appPath).catch(() => {
        throw new CuaHelperError(`${UNAUTHORIZED} (code signature verification unavailable)`, {
          code: "not_authorized",
        });
      });
      const expectedTeam = (env.FREECODEZ_CUA_HELPER_TEAM_ID ?? env.ZCODE_CUA_HELPER_TEAM_ID)?.trim();
      if (expectedTeam) {
        const team = await dependencies.verifyTeamIdentifier(appPath).catch(() => {
          throw new CuaHelperError(`${UNAUTHORIZED} (TeamIdentifier verification unavailable)`, {
            code: "not_authorized",
          });
        });
        if (team !== expectedTeam) {
          throw new CuaHelperError(
            `Computer Use Helper TeamIdentifier mismatch: expected ${expectedTeam}, found ${String(team)}`,
            { code: "not_authorized" },
          );
        }
      }
    },
  };
}

async function copyDirectory(source, target) {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyDirectory(from, to);
    } else if (entry.isFile()) {
      await copyFile(from, to);
    }
  }
}

async function readBundleIdentityManifest(appPath) {
  // Windows 面无需 Helper.app 身份清单;mac 面由产线生成 Contents/Resources/identity.json。
  // （Contents/ 根只认 Info.plist/MacOS/Resources 等标准条目——束根或 Contents 根放杂项
  // 都会让 codesign 报 unsealed contents/unsealed root，Resources/ 是唯一可签的家。）
  try {
    const raw = await readFile(join(appPath, "Contents", "Resources", "identity.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.bundleId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** broker 轮换 marker 路径/发布(与 socket 同目录,文件名固定)。 */
export function cuaBrokerRefreshMarkerPath(socketPath) {
  if (typeof socketPath !== "string" || !socketPath) return undefined;
  if (socketPath.startsWith("\\\\.\\pipe\\")) {
    return join(tmpdir(), `${socketPath.slice("\\\\.\\pipe\\".length)}.refresh`);
  }
  return `${socketPath}.refresh`;
}

export async function publishCuaBrokerRefreshMarker(socketPath, options = {}) {
  const path = cuaBrokerRefreshMarkerPath(socketPath);
  if (!path) throw new CuaHelperError("broker socket path is required", { code: "invalid_request" });
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  await writeFile(path, String(options.now ? options.now() : Date.now()), "utf8");
  return { path };
}

/**
 * 原生 addon 加载(WH:14715-14785 同序):env `ZCODE_CUA_HELPER_ADDON` →
 * `<exec>/../Resources/ax_native.node` → 上溯 8 级 `build/Release/ax_native.node`。
 */
export function resolvePackagedNativeAddonPath(options = {}) {
  const env = options.env ?? process.env;
  const explicit = env[HELPER_ADDON_ENV];
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const execPath = options.execPath ?? process.execPath;
  const candidate = resolve(dirname(execPath), "..", "Resources", "ax_native.node");
  return candidate;
}

export function resolveInTreeAddonPath(options = {}) {
  let dir = dirname(options.entryPath ?? process.cwd());
  for (let level = 0; level < 8; level += 1) {
    const candidate = join(dir, "build", "Release", "ax_native.node");
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // 继续上溯。
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function loadRealNativeAddon(options = {}) {
  const explicit = resolvePackagedNativeAddonPath(options);
  const candidates = [explicit, resolveInTreeAddonPath(options)].filter(Boolean);
  let lastError;
  for (const candidate of candidates) {
    try {
      return createRequire(import.meta.url)(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw new CuaHelperError(
    `Computer Use native addon could not be loaded (${lastError instanceof Error ? lastError.message : String(lastError)})`,
    { code: "helper_unavailable" },
  );
}

/** AX 只读方法表:从原生 addon 源挑选只读绑定(registry 可选过滤)。 */
export function createAxReadOnlyMethods(source, registry, _options) {
  const methods = {};
  if (!source || typeof source !== "object") return methods;
  const allow = registry instanceof Set ? registry : undefined;
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "function") continue;
    if (allow && !allow.has(name)) continue;
    methods[name] = value.bind(source);
  }
  return methods;
}

export const ROLE_TO_KIND = Object.freeze({
  tool: "tool",
  presentation: "presentation",
  legacy: "tool",
  anonymous: "tool",
});

export function roleToKind(role) {
  return ROLE_TO_KIND[role];
}

// W-13(照抄官方 CuaHelperLifecycleManager):转移串行化 + retiring 队列 + retention 判定。
// acquire 只在无 current 时 create(shouldRetainCurrent 决定是否退役现有实例),
// restartHelper 不再泄漏孤儿;dispose 聚合多实例停止错误。
export class CuaHelperLifecycleManager {
  #stopInstance;
  #current;
  #retiring;
  #terminal = false;
  #transitionTail = Promise.resolve();
  #disposePromise;
  constructor(stopInstance) {
    this.#stopInstance = stopInstance;
    this.#current = undefined;
  }
  get disposed() {
    return this.#terminal;
  }
  isCurrent(managed) {
    return !this.#terminal && this.#current === managed;
  }
  peek() {
    return this.#terminal ? undefined : this.#current;
  }
  acquire(options) {
    return this.#enqueue(async () => {
      if (this.#terminal) return undefined;
      await this.#finishRetiringInstance();
      if (this.#terminal) return undefined;
      if (typeof options?.isAdmitted === "function" && !options.isAdmitted()) {
        await this.#stopCurrentIfNeeded(options.shouldRetainCurrent);
        return undefined;
      }
      if (!this.#current) this.#current = options?.create?.();
      return this.#current;
    });
  }
  reconcile(shouldRetainCurrent) {
    return this.#enqueue(async () => {
      if (this.#terminal) return;
      await this.#finishRetiringInstance();
      if (this.#terminal) return;
      await this.#stopCurrentIfNeeded(shouldRetainCurrent);
    });
  }
  dispose(managed) {
    if (this.#disposePromise) return this.#disposePromise;
    this.#terminal = true;
    if (managed !== undefined && this.#current === undefined) this.#current = managed;
    this.#disposePromise = this.#enqueue(async () => {
      const current = this.#current;
      const retiring = this.#retiring;
      this.#current = undefined;
      this.#retiring = undefined;
      const targets = [retiring, current].filter(
        (target, index, all) => target !== undefined && all.indexOf(target) === index,
      );
      const errors = [];
      for (const target of targets) {
        try {
          await this.#stopInstance(target);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Failed to stop Computer Use Helper instances");
      }
    });
    return this.#disposePromise;
  }
  async #stopCurrentIfNeeded(shouldRetainCurrent) {
    const current = this.#current;
    if (!current) return;
    if (typeof shouldRetainCurrent === "function" && shouldRetainCurrent(current)) return;
    this.#current = undefined;
    this.#retiring = current;
    await this.#finishRetiringInstance();
  }
  async #finishRetiringInstance() {
    const retiring = this.#retiring;
    if (!retiring) return;
    await this.#stopInstance(retiring);
    if (this.#retiring === retiring) this.#retiring = undefined;
  }
  #enqueue(operation) {
    const next = this.#transitionTail.then(operation, operation);
    this.#transitionTail = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}

// W-12(照抄官方 registry):workspaceKey 键控的启用面记账 + snapshot/pruneDisabled 读面。
export class CuaProductHelperWorkspaceRegistry {
  #targetsByWorkspaceKey = new Map();
  setEnabled(context, enabled) {
    const workspaceKey = context?.workspaceKey?.trim() || context?.workspaceIdentity?.trim() || context?.workspacePath || "";
    if (!workspaceKey) return;
    if (!enabled) {
      this.#targetsByWorkspaceKey.delete(workspaceKey);
      return;
    }
    this.#targetsByWorkspaceKey.set(workspaceKey, {
      workspacePath: context?.workspacePath,
      ...(context?.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
    });
  }
  snapshot() {
    return [...this.#targetsByWorkspaceKey.values()];
  }
  pruneDisabled(isEnabled) {
    for (const [key, target] of this.#targetsByWorkspaceKey) {
      if (!isEnabled(target)) this.#targetsByWorkspaceKey.delete(key);
    }
  }
}

// R19：darwin 委托真实现（安装→验签→spawn→健康 pid 对账；接口=本文件 .d.ts 的 CuaHelperHost）。
// buildHelperOpenArgs 经参数注入保持单一事实源；未显式传 installer 时以本模块工厂构造
// （node.ts 的 createDefaultCuaProductHelper 总是显式传 canonical installer）。
export function createProductCuaHelperHost(options = {}) {
  if (process.platform !== "darwin") {
    return createUnavailableCuaHelperHost();
  }
  return createMacProductHelperHost({
    ...options,
    buildHelperOpenArgs,
    helperInstaller:
      options.helperInstaller ??
      createCuaHelperInstaller({
        env: options.env,
        bundledAppPath: options.bundledHelperAppPath,
      }),
  });
}

function createUnavailableCuaHelperHost() {
  return {
    get running() {
      return false;
    },
    get socketPath() {
      return null;
    },
    get pluginAuthority() {
      return null;
    },
    get reservedTransport() {
      return undefined;
    },
    start: unavailableReject,
    stop: async () => {},
    restart: unavailableReject,
    restartAfterCurrentStart: unavailableReject,
    waitForTransport: unavailableReject,
    checkHealth: unavailableReject,
    queryScreenCaptureProbe: async () => ({
      ok: false,
      reason: `${UNAVAILABLE} (screen capture probe is macOS-only)`,
    }),
    queryScreenRecordingPreflight: async () => undefined,
    queryPermissionStatus: async () => ({}),
  };
}

// W-12(G9 照抄官方 resolveOfficialCuaPluginEnablementState):读 config 链判插件启用。
// 官方语义:enabled = features.mcp && plugins.enabled && plugins.enabledPlugins[pluginId];
// 源序 = userConfig(fork 数据目录) → 项目配置链(zcode.json / .freecodez/config.json,
// 自 workingDirectory 上溯到 .git worktree 根,root-first)。无任何配置 ⇒ 默认关闭。
export const ZCODE_CUA_OFFICIAL_PLUGIN_ID = "computer-use@zcode-plugins-official";

function readJsonObject(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasWorktreeMarker(dir) {
  try {
    const stats = statSync(join(dir, ".git"));
    return stats.isDirectory() || stats.isFile();
  } catch {
    return false;
  }
}

function getProjectConfigDirectories(dir) {
  const chain = [];
  let current = dir;
  for (;;) {
    chain.push(current);
    if (hasWorktreeMarker(current)) return chain.reverse();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [dir];
}

function discoverProjectConfigPaths(workingDirectory) {
  const root = resolve(workingDirectory ?? process.cwd());
  return getProjectConfigDirectories(root).flatMap((dir) =>
    [join(dir, "zcode.json"), join(dir, ".freecodez", "config.json")].filter((path) => existsSync(path)),
  );
}

function resolveOfficialCuaPluginEnablementState(input) {
  let mcpAllowed = true;
    let pluginsEnabled = true;
    let pluginEnabled = false;
  const sources = [
    ...(input.userConfigPath ? [input.userConfigPath] : []),
    ...discoverProjectConfigPaths(input.workingDirectory),
    ...(input.projectConfigPath ? [input.projectConfigPath] : []),
  ];
  for (const path of sources) {
    const config = readJsonObject(path);
    if (!config) continue;
    if (hasOwn(config, "features")) {
      const features = config.features;
      if (features && typeof features === "object") {
        if (hasOwn(features, "mcp")) mcpAllowed = features.mcp === true;
      } else {
        mcpAllowed = false;
      }
    }
    if (hasOwn(config, "plugins")) {
      const plugins = config.plugins;
      if (!plugins || typeof plugins !== "object") {
        pluginsEnabled = false;
        pluginEnabled = false;
        continue;
      }
      if (hasOwn(plugins, "enabled")) pluginsEnabled = plugins.enabled === true;
      if (hasOwn(plugins, "enabledPlugins")) {
        const enabledPlugins = plugins.enabledPlugins;
        if (enabledPlugins && typeof enabledPlugins === "object") {
          if (hasOwn(enabledPlugins, ZCODE_CUA_OFFICIAL_PLUGIN_ID)) {
            pluginEnabled = enabledPlugins[ZCODE_CUA_OFFICIAL_PLUGIN_ID] === true;
          }
        } else {
          pluginEnabled = false;
        }
      }
    }
  }
  return { enabled: mcpAllowed && pluginsEnabled && pluginEnabled };
}

export function isOfficialCuaPluginEnabledForWorkspace(options) {
  const env = options?.env ?? process.env;
  const home = env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
  const userConfigPath = join(home, ".freecodez", "cli", "config.json");
  return resolveOfficialCuaPluginEnablementState({
    userConfigPath,
    workingDirectory: options?.workingDirectory,
    projectConfigPath: options?.projectConfigPath,
  }).enabled;
}

// W-13 S2-9:restart 实装为 stop→start(授权后 restartHelper 可用),不再恒 throw。
// resolveMcpServers 维持官方 passthrough 语义(过滤/注入由 services 装配层负责)。
export function createCuaProductMcpServerResolver(host, _options) {
  return {
    async resolveMcpServers(servers) {
      return servers;
    },
    async restart() {
      if (!host || typeof host.stop !== "function" || typeof host.start !== "function") {
        throw new CuaHelperError(UNAVAILABLE, { code: "not_authorized" });
      }
      await host.stop();
      await host.start();
    },
    async restartAfterPermissionGrant() {
      if (!host || typeof host.stop !== "function" || typeof host.start !== "function") {
        throw new CuaHelperError(UNAVAILABLE, { code: "not_authorized" });
      }
      await host.stop();
      await host.start();
    },
  };
}

/** 启动等待:给定 deadline 内等待 startup promise,超时抛 timeout。 */
export async function waitForCuaHelperStartup(startup, deadlineMs = 30_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new CuaHelperError("Computer Use Helper startup timed out", { code: "timeout" })),
      deadlineMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([startup, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function isPotentialZCodeCuaAgentMcpServer(server) {
  if (!server || typeof server !== "object") return false;
  const name = typeof server.name === "string" ? server.name : "";
  return name === "node_repl" || name.startsWith("mcp__computer-use__") || name.startsWith("mcp__computer_use__");
}

export function isScreenCaptureProbeSuccess(probe) {
  return Boolean(probe) && typeof probe === "object" && probe.ok === true;
}

const agentEnvUnavailable = new WeakSet();

export function markCuaProductHelperAgentEnvUnavailable(host) {
  agentEnvUnavailable.add(host);
}

export function hasCuaProductHelperAgentEnvUnavailable(host) {
  return agentEnvUnavailable.has(host);
}

export function clearCuaProductHelperAgentEnvUnavailable(host) {
  agentEnvUnavailable.delete(host);
}

export async function reapOrphanedHelpers(_options) {
  // Windows 侧孤儿 helper 由父进程存活看门狗自弃(5s 探 --parent-pid);无需额外收割。
}

export async function requestHelperAccessibilityPermissionViaLaunchServices(_options) {
  return { ok: false, reason: `${UNAVAILABLE} (LaunchServices permission flow is macOS-only)` };
}

export async function requestHelperScreenRecordingPermissionViaLaunchServices(_options) {
  return { ok: false, reason: `${UNAVAILABLE} (LaunchServices permission flow is macOS-only)` };
}
