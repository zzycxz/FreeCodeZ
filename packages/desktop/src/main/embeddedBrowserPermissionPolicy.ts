import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Session, WebContents } from "electron";
import {
  EMBEDDED_BROWSER_AUTO_ALLOWED_PERMISSIONS,
  EMBEDDED_BROWSER_PROMPT_TIMEOUT_MS,
  embeddedBrowserSitePermissionsFileSchema,
  isEmbeddedBrowserAskablePermission,
  isEmbeddedBrowserDevicePermission,
  type EmbeddedBrowserPermissionAction,
  type EmbeddedBrowserPermissionPrompt,
  type EmbeddedBrowserSitePermissionsFile,
} from "@zcode/shared";

// ============================================================
// U2-4（移植自 ZCode 3.15.1 站点权限体系，上游 main@≈527158/742108）：
// 决策序=持久站点设置 → 本次运行 session-allow → 询问（20s 超时=拒绝）→ default-deny。
// U1-4 止血版在本模块原位升级：询问流/持久化/设备与屏幕共享接入后，止血的
// 「其余一律拒绝」成为决策链末端语义，不再需要独立开关。
// ============================================================

const AUTO_ALLOWED = new Set<string>(EMBEDDED_BROWSER_AUTO_ALLOWED_PERMISSIONS);

/** U1-4 止血断言锚点：allowlist 判定的单一决策源（决策链首位）。 */
export function isEmbeddedBrowserPermissionAutoAllowed(permission: string): boolean {
  return AUTO_ALLOWED.has(permission);
}

type PromptDispatcher = (prompt: EmbeddedBrowserPermissionPrompt) => void;

export interface EmbeddedBrowserSitePermissionStore {
  get(origin: string, permission: string): "allow" | "deny" | undefined;
  set(origin: string, permission: string, value: "allow" | "deny"): void;
  clear(): void;
  reset(origin: string, permission: string): void;
  all(): EmbeddedBrowserSitePermissionsFile["entries"];
}

/** 上游 store（742108）：origin×permission→allow|deny，临时文件+rename 原子写，load 白名单清洗。 */
export function createEmbeddedBrowserSitePermissionStore(filePath: string): {
  store: EmbeddedBrowserSitePermissionStore;
  load: () => Promise<void>;
  /** 等待落盘收敛（测试用；生产链路为 best-effort 异步）。 */
  flush: () => Promise<void>;
} {
  let entries: EmbeddedBrowserSitePermissionsFile["entries"] = {};
  let dirty = false;
  // flush 串行链：best-effort 触发可并发，落盘必须排队（tmp+rename 原子写不留竞态）。
  let flushChain: Promise<void> = Promise.resolve();

  function flush(): Promise<void> {
    if (!dirty) return flushChain;
    dirty = false;
    const payload = JSON.stringify({ version: 1, entries } satisfies EmbeddedBrowserSitePermissionsFile);
    const tmp = `${filePath}.${randomUUID()}.tmp`;
    flushChain = flushChain.then(async () => {
      await writeFile(tmp, payload, "utf8");
      await rename(tmp, filePath);
    });
    return flushChain;
  }

  const store: EmbeddedBrowserSitePermissionStore = {
    get(origin, permission) {
      return entries[origin]?.[permission];
    },
    set(origin, permission, value) {
      const perOrigin = { ...entries[origin] };
      perOrigin[permission] = value;
      entries = { ...entries, [origin]: perOrigin };
      dirty = true;
      // 落盘失败不阻塞决策（内存态已生效）；链尾拒绝由后续 flush 自然重试。
      void flush().catch(() => {});
    },
    clear() {
      entries = {};
      dirty = true;
      void flush().catch(() => {});
    },
    reset(origin, permission) {
      const perOrigin = { ...entries[origin] };
      delete perOrigin[permission];
      entries = { ...entries, [origin]: perOrigin };
      dirty = true;
      void flush().catch(() => {});
    },
    all() {
      return entries;
    },
  };

  async function load(): Promise<void> {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = embeddedBrowserSitePermissionsFileSchema.safeParse(JSON.parse(raw));
      // 白名单清洗：schema strict 校验即上游的 load 清洗语义；失败回退空表。
      entries = parsed.success ? parsed.data.entries : {};
    } catch {
      entries = {};
    }
  }

  return { store, load, flush: () => flush() };
}

function originOf(webContents: WebContents | null | undefined): string | undefined {
  try {
    const url = webContents?.getURL?.() ?? "";
    return url ? new URL(url).origin : undefined;
  } catch {
    return undefined;
  }
}

export interface EmbeddedBrowserPermissionPolicyDeps {
  /** 询问分发（main→renderer webContents.send 由装配层注入）。 */
  dispatchPrompt: PromptDispatcher;
  logger: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void };
}

/**
 * 在内置浏览器 session 上安装完整站点权限策略（U2-4；幂等，重复调用覆写同组 handler）。
 * 挂载点=main bootstrap（网络策略之后）；session=EMBEDDED_BROWSER_PARTITION。
 */
export function applyEmbeddedBrowserPermissionPolicy(
  embeddedSession: Session,
  deps: EmbeddedBrowserPermissionPolicyDeps & {
    store: EmbeddedBrowserSitePermissionStore;
    /** 桥接主窗口清单：询问卡发给所有存活 app 窗口（renderer 按 guestWebContentsId 归 tab）。 */
    listPromptTargets: () => WebContents[];
    /** 屏幕共享源枚举（desktopCapturer 装配注入，测试可替换）。 */
    listScreenSources?: () => Promise<{ id: string; name: string }[]>;
  },
): {
  /** renderer 应答入口（装配层把 IPC invoke 转进来）。 */
  resolvePrompt: (resolution: {
    requestId: string;
    action: EmbeddedBrowserPermissionAction;
    selectedDeviceId?: string;
  }) => boolean;
} {
  const { store, dispatchPrompt, logger } = deps;
  /** 本次运行 session-allow 集（上游「仅本次允许」：内存集，重启即失）。 */
  const sessionAllowed = new Set<string>();
  /** 在途询问：requestId → { resolve, timer }。20 秒超时=拒绝（上游同款）。 */
  const pendingPrompts = new Map<
    string,
    (action: EmbeddedBrowserPermissionAction, deviceId?: string) => void
  >();

  const sessionKey = (origin: string, permission: string): string => `${origin}\u0000${permission}`;

  function dispatchPromptAndWait(prompt: EmbeddedBrowserPermissionPrompt): Promise<{
    action: EmbeddedBrowserPermissionAction;
    deviceId?: string;
  }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingPrompts.delete(prompt.requestId);
        logger.warn("[embedded-browser-permission] prompt timed out (denied)", {
          origin: prompt.origin,
          permission: prompt.permission,
        });
        resolve({ action: "dismiss" });
      }, EMBEDDED_BROWSER_PROMPT_TIMEOUT_MS);
      pendingPrompts.set(prompt.requestId, (action, deviceId) => {
        clearTimeout(timer);
        resolve({ action, deviceId });
      });
      dispatchPrompt(prompt);
    });
  }

  /** 上游 ask():抛询问并等 renderer 应答；询问通道不可用时 default-deny（fail closed）。 */
  async function askUser(
    prompt: Omit<EmbeddedBrowserPermissionPrompt, "requestId">,
  ): Promise<{ action: EmbeddedBrowserPermissionAction; deviceId?: string } | null> {
    if (deps.listPromptTargets().length === 0) return null;
    try {
      return await dispatchPromptAndWait({ ...prompt, requestId: randomUUID() });
    } catch (error) {
      logger.warn("[embedded-browser-permission] prompt dispatch failed", error);
      return null;
    }
  }

  embeddedSession.setPermissionRequestHandler((webContents, permission, callback) => {
    void (async () => {
      const origin = originOf(webContents) ?? "unknown";
      if (AUTO_ALLOWED.has(permission)) {
        callback(true);
        return;
      }
      // 决策序 1：持久站点设置。
      const persisted = store.get(origin, permission);
      if (persisted !== undefined) {
        callback(persisted === "allow");
        return;
      }
      // 决策序 2：本次运行 session-allow。
      if (sessionAllowed.has(sessionKey(origin, permission))) {
        callback(true);
        return;
      }
      // 决策序 3：询问（可询问 13 项）；设备与屏幕共享走专用询问。
      if (!isEmbeddedBrowserAskablePermission(permission) && !isEmbeddedBrowserDevicePermission(permission)) {
        logger.warn("[embedded-browser-permission] denied (default-deny)", { permission, origin });
        callback(false);
        return;
      }
      const kind = isEmbeddedBrowserDevicePermission(permission)
        ? "device"
        // Electron 的 permissionRequestHandler 类型面不含 "display"（走 setDisplayMediaRequestHandler），
        // 但运行时字符串可能到达，这里按字符串比较保留 screen-share 分支。
        : (permission as string) === "display"
          ? "screen-share"
          : "permission";
      let options: { id: string; name: string }[] | undefined;
      if (kind === "screen-share" && deps.listScreenSources) {
        options = await deps.listScreenSources();
      }
      const answer = await askUser({
        kind,
        origin,
        permission,
        guestWebContentsId: webContents?.id ?? 0,
        ...(options ? { options: options.map((option) => ({ deviceId: option.id, name: option.name })) } : {}),
      });
      if (!answer) {
        // 无窗口可询问 / 分发失败：fail closed。
        logger.warn("[embedded-browser-permission] denied (prompt unavailable)", {
          permission,
          origin,
        });
        callback(false);
        return;
      }
      switch (answer.action) {
        case "allow-always":
          store.set(origin, permission, "allow");
          callback(true);
          return;
        case "allow-session":
          sessionAllowed.add(sessionKey(origin, permission));
          callback(true);
          return;
        case "block-always":
          store.set(origin, permission, "deny");
          callback(false);
          return;
        default:
          callback(false);
      }
    })();
  });

  // 同步查询与请求侧同判：allowlist → 持久站点设置（同步可读）→ 本次 session-allow。
  // 「询问」无法同步裁决，按未授权返回——与上游「持久层同步可见」的语义对齐：
  // 用户选了「访问此网站时允许」后 navigator.permissions.query 不再误报 denied。
  embeddedSession.setPermissionCheckHandler((webContents, permission) => {
    if (AUTO_ALLOWED.has(permission)) return true;
    const origin = originOf(webContents);
    if (origin !== undefined) {
      const persisted = store.get(origin, permission);
      if (persisted !== undefined) return persisted === "allow";
      if (sessionAllowed.has(sessionKey(origin, permission))) return true;
    }
    return false;
  });

  // 设备权限（usb/hid/serial）：经询问卡选择设备（上游 select-*-device 事件同语义）。
  embeddedSession.setDevicePermissionHandler((details) => {
    // Electron ≥25 该 handler 是单参数签名（details 内含 origin/deviceType）；
    // 曾误写 (_webContents, details) 双参——运行时首参其实是 details，
    // origin 会恒为 unknown，导致持久化 allow 永远匹配不上（设备权限全被拒）。
    // Electron 的 devicepermission 同步接口无法挂异步询问：设备类权限
    // 首次请求经 setPermissionRequestHandler 的 device 分支询问持久化 allow 后，
    // 此处放行该设备类别。
    return store.get(details.origin, details.deviceType) === "allow";
  });

  // 屏幕共享（getDisplayMedia）：异步询问选源后回传。
  embeddedSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void (async () => {
        const sources = deps.listScreenSources ? await deps.listScreenSources() : [];
        const answer = await askUser({
          kind: "screen-share",
          origin: "screen",
          permission: "display",
          guestWebContentsId: 0,
          options: sources.map((source) => ({ deviceId: source.id, name: source.name })),
        });
        const selected = answer?.deviceId;
        if (answer?.action !== "allow-session" && answer?.action !== "allow-always") {
          // Electron 运行时约定 callback(null) = 拒绝授流；d.ts 形参非空，经 unknown 二段收窄。
          (callback as unknown as (streams: null) => void)(null);
          return;
        }
        const source = sources.find((candidate) => candidate.id === selected) ?? sources[0];
        callback({ video: source ? { id: source.id, name: source.name } : undefined });
      })();
    },
    { useSystemPicker: false },
  );

  /** renderer 应答入口（装配层把 IPC invoke 转进来）。 */
  function resolvePrompt(resolution: {
    requestId: string;
    action: EmbeddedBrowserPermissionAction;
    selectedDeviceId?: string;
  }): boolean {
    const pending = pendingPrompts.get(resolution.requestId);
    if (!pending) return false;
    pendingPrompts.delete(resolution.requestId);
    pending(resolution.action, resolution.selectedDeviceId);
    return true;
  }

  return { resolvePrompt };
}
