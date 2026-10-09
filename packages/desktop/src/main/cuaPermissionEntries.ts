// R21c 权限条目自动化（computer-control-capability.md R21c，2026-10-09 用户裁决）：
// 主应用 + FreeCodeZ Computer Use 的 TCC 条目一律由应用自身产生（装机首启即建；
// 打开电脑控制权限页兜底再跑一次），不走手动 +/拖拽。
// 主应用 = 录屏自注册（R21b 共享件）+ AX 自注册；helper = 一次性请求模式拉起
// （--request-permissions：AX + 录屏各建一行，系统弹窗与存活进程绑定）。
// 每进程只跑一次（幂等）；任何失败只记日志，绝不阻断启动/设置页。
import { execFile } from "node:child_process";
import { join } from "node:path";
import { HELPER_ENTRY_RELATIVE_PATH } from "@zcode/zcode-cua/broker/helperConstants";
import {
  probePermissionsInProcess,
  requestAccessibilityAccessInProcess,
} from "@zcode/zcode-cua/macos";
import { ensureMainScreenRecordingRegistration } from "./cuaScreenRecordingRegistration.js";

/** helper 一次性请求模式的拉起超时；请求本体由 helper 自己驻留（至多 30s）。 */
const HELPER_REQUEST_SPAWN_TIMEOUT_MS = 60_000;

export interface CuaPermissionEntriesResult {
  ok: boolean;
  attempted: boolean;
  helperSpawned: boolean;
  reason?: string;
}

export interface EnsureCuaPermissionEntriesOptions {
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
  };
  platform?: NodeJS.Platform;
  /** 测试注入；生产默认惰性走 desktopCuaHelperInstaller（install + verify）。 */
  ensureHelperInstalled?: () => Promise<string>;
  /** 测试注入；生产默认 spawn 安装束内 helper 的一次性请求模式。 */
  spawnHelperRequest?: (helperAppPath: string) => Promise<void>;
  /** 测试注入；生产默认 koffi 进程内真实现。 */
  probeMainAccessibility?: () => boolean;
  requestMainAccessibility?: () => boolean;
  /** 测试注入（防测试进程真弹窗）；生产默认 koffi 进程内真实现。 */
  probeMainScreenCapture?: () => boolean;
  requestMainScreenCapture?: () => { granted: boolean };
}

let entriesRequested = false;

/** 测试专用：重置进程级幂等门。 */
export function resetCuaPermissionEntriesForTests(): void {
  entriesRequested = false;
}

export async function ensureCuaPermissionEntries(
  options: EnsureCuaPermissionEntriesOptions = {},
): Promise<CuaPermissionEntriesResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return { ok: true, attempted: false, helperSpawned: false, reason: "not_darwin" };
  }
  if (entriesRequested) {
    return { ok: true, attempted: false, helperSpawned: false, reason: "already_attempted" };
  }
  entriesRequested = true;
  const log = (message: string, context?: Record<string, unknown>) =>
    options.logger?.info?.(message, context);

  // 主应用：录屏（R21b 共享件；已授权零弹窗）+ AX 自注册（已信任零弹窗）。
  ensureMainScreenRecordingRegistration({
    log,
    probeScreenCapture: options.probeMainScreenCapture,
    requestScreenCaptureAccess: options.requestMainScreenCapture,
  });
  try {
    const trusted =
      (options.probeMainAccessibility ?? (() => probePermissionsInProcess().accessibility))();
    if (!trusted) {
      const granted = (
        options.requestMainAccessibility ?? (() => requestAccessibilityAccessInProcess().granted)
      )();
      log("[cua-permission-entries] main app accessibility self-registration", { granted });
    }
  } catch (error) {
    options.logger?.warn?.(
      "[cua-permission-entries] main app accessibility request failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  // helper：安装（验签）→ 一次性请求模式拉起。失败只记日志（条目可等下次兜底）。
  try {
    const helperAppPath = await (
      options.ensureHelperInstalled ?? defaultEnsureHelperInstalled
    )();
    await (options.spawnHelperRequest ?? spawnHelperPermissionRequest)(helperAppPath);
    log("[cua-permission-entries] helper permission request spawned", { helperAppPath });
    return { ok: true, attempted: true, helperSpawned: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    options.logger?.warn?.("[cua-permission-entries] helper permission request failed", reason);
    return { ok: true, attempted: true, helperSpawned: false, reason };
  }
}

async function defaultEnsureHelperInstalled(): Promise<string> {
  // electron 依赖惰性化（本模块要能在无 electron 的测试进程加载）。
  const { createDesktopCuaHelperInstaller } = await import("./desktopCuaHelperInstaller.js");
  return createDesktopCuaHelperInstaller({ platform: "darwin" }).ensureInstalled();
}

/**
 * 一次性权限请求的 LaunchServices 拉起 argv（纯函数，供测试钉形状）。
 * 必须走 `open -n -a` 而非直接 execFile：直接 spawn 的子进程在 TCC 上继承父进程为责任主体
 * （helper 的请求会被记到 FreeCodeZ.app 头上——已授权=静默 no-op，helper 自己的行永远建不出
 * 来，2026-10-09 装机实证）；LaunchServices 形态让 helper 以自身 bundle 身份成为责任主体，
 * `-n` 保证即便已有常驻 helper 也新起实例跑一次性模式。`--args` 后首参必须是入口脚本绝对路径
 * （node 底座缺 entry 会把旗标当自身 CLI 选项即退，R19 修补注）。
 */
export function buildHelperPermissionRequestOpenArgs(helperAppPath: string): string[] {
  return [
    "-n",
    "-a",
    helperAppPath,
    "--args",
    join(helperAppPath, HELPER_ENTRY_RELATIVE_PATH),
    "--request-permissions",
  ];
}

/**
 * 经 LaunchServices 拉起 helper 一次性权限请求模式。只等 `open` 即返回（条目在请求当刻
 * 已创建）；helper 驻留/退出不影响本侧。
 */
export function spawnHelperPermissionRequest(
  helperAppPath: string,
  runCommand: (file: string, args: string[]) => Promise<void> = defaultOpenCommand,
): Promise<void> {
  return runCommand("/usr/bin/open", buildHelperPermissionRequestOpenArgs(helperAppPath));
}

function defaultOpenCommand(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { timeout: HELPER_REQUEST_SPAWN_TIMEOUT_MS, windowsHide: true },
      () => {
        // 退出码/超时都无所谓：TCC 条目在请求当刻已创建，空回调只回收子进程。
      },
    );
    child.once("spawn", () => resolve());
    child.once("error", (error) => reject(error));
  });
}
