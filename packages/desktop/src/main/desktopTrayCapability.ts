import { execFile } from "node:child_process";

// ============================================================
// U3-4（移植自 ZCode 3.15.1 Linux 托盘能力探测，上游 main@≈574500-577500
// detectDesktopCloseToTrayCapability / createCloseToTrayCapabilityMonitor 逐结构对照）
// ============================================================
// 语义：Linux 关窗驻留依赖系统托盘（StatusNotifier/AppIndicator）。探测=DBus 上
// org.kde.StatusNotifierWatcher 是否有属主，依次尝试 gdbus/busctl/qdbus 三个客户端
// （1500ms 超时，windowsHide），任一应答 true 即 supported。GNome 裸环境默认没有
// StatusNotifierWatcher（需 AppIndicator 扩展），单独给出 gnomeLikeWithoutTray 供
// 设置页提示。探测失败（无客户端/超时）=unsupported（保守方向，与上游同）。

export interface LinuxCloseToTrayCapability {
  supported: boolean;
  gnomeLikeWithoutTray: boolean;
}

type RunCommand = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<string>;

const PROBE_TIMEOUT_MS = 1_500;

function defaultRunCommand(file: string, args: string[], options: { timeout: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: options.timeout, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout ?? ""));
    });
  });
}

/** 应答解析（上游同款三形态：gdbus `(true,)`、busctl `b "true"`、qdbus `true`）。 */
export function probeResponseIndicatesTraySupport(stdout: string): boolean {
  return /true/i.test(stdout);
}

function isGnomeLikeDesktop(env: NodeJS.ProcessEnv | undefined): boolean {
  const desktop = `${env?.XDG_CURRENT_DESKTOP ?? ""} ${env?.XDG_SESSION_DESKTOP ?? ""}`.toLowerCase();
  return desktop.includes("gnome");
}

/** Linux 关窗驻留能力探测：任一 DBus 客户端应答 true 即 supported。 */
export async function detectLinuxCloseToTrayCapability(options?: {
  run?: RunCommand;
  env?: NodeJS.ProcessEnv;
}): Promise<LinuxCloseToTrayCapability> {
  const run = options?.run ?? defaultRunCommand;
  const env = options?.env ?? process.env;
  const commands = [
    {
      file: "gdbus",
      args: [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.DBus",
        "--object-path",
        "/org/freedesktop/DBus",
        "--method",
        "org.freedesktop.DBus.NameHasOwner",
        "org.kde.StatusNotifierWatcher",
      ],
    },
    {
      file: "busctl",
      args: [
        "--user",
        "call",
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "NameHasOwner",
        "org.kde.StatusNotifierWatcher",
      ],
    },
    {
      file: "qdbus",
      args: [
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "NameHasOwner",
        "org.kde.StatusNotifierWatcher",
      ],
    },
  ];
  let supported = false;
  for (const command of commands) {
    try {
      const stdout = await run(command.file, command.args, { timeout: PROBE_TIMEOUT_MS });
      if (probeResponseIndicatesTraySupport(stdout)) {
        supported = true;
        break;
      }
    } catch {
      // 客户端缺席/超时：尝试下一个。
    }
  }
  return { supported, gnomeLikeWithoutTray: !supported && isGnomeLikeDesktop(env) };
}

const CAPABILITY_CACHE_STALE_MS = 10_000;

/**
 * 能力监视器（上游 createCloseToTrayCapabilityMonitor）：getSync 取缓存（可为 null），
 * refresh 强制重探；缓存 10s 视为过期，过期后 getSync 返回 null 交由调用方决定重探时机。
 */
export function createCloseToTrayCapabilityMonitor(options?: {
  detect?: () => Promise<LinuxCloseToTrayCapability>;
}): {
  getSync: () => LinuxCloseToTrayCapability | null;
  refresh: () => Promise<LinuxCloseToTrayCapability>;
} {
  const detect = options?.detect ?? detectLinuxCloseToTrayCapability;
  let cached: LinuxCloseToTrayCapability | null = null;
  let cachedAt = 0;
  let inFlight: Promise<LinuxCloseToTrayCapability> | null = null;
  return {
    getSync() {
      if (cached !== null && Date.now() - cachedAt <= CAPABILITY_CACHE_STALE_MS) return cached;
      return null;
    },
    refresh() {
      inFlight ??= detect().then((capability) => {
        cached = capability;
        cachedAt = Date.now();
        inFlight = null;
        return capability;
      });
      return inFlight;
    },
  };
}
