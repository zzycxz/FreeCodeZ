// FreeCodeZ W-14 桥接（S1-S5 缝替换，FC 自有件）：node_repl 进程内暴露新引擎 SDK。
// 旧栈（cua-bridge.ts Symbol.for broker 客户端）已随 W-03 拆除；本件按 browser-bridge
// 同构模式重建：Symbol.for 全局 + 懒启动 sidecar + subagent 拒绝（三外沿保留）。
// 引擎经 engine-bridge（JS+d.ts）隔离接入——nodenext 与 bundler 解析边界的既定先例。
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSocket, type Socket } from "node:dgram";
import type { NodeReplRequestMeta } from "@zcode/core/repl";
import {
  buildCuaToolDisplay,
  createEngineSdk,
  createSidecarHarness,
  type SidecarHarness,
} from "./engine-bridge/index.js";
import {
  COMPUTER_UNAVAILABLE_IN_SUBAGENT_MESSAGE,
  NODE_REPL_COMPUTER_BRIDGE_SYMBOL,
} from "./runtime-bridge.js";

export { NODE_REPL_COMPUTER_BRIDGE_SYMBOL } from "./runtime-bridge.js";

export interface ActiveComputerCall {
  generation: number;
  requestMeta: NodeReplRequestMeta;
  runtimeScope: "main" | "subagent";
  sessionId: string;
  signal: AbortSignal;
}

export interface ComputerBridgeSession {
  mergeResponseMeta(meta: Record<string, unknown>): void;
}

/** sidecar 产物路径：S7 env 注入（FREECODEZ_CUA_ENGINE_SIDECAR=引擎 dist 目录）优先，
 * 开发态兜底 workspace 引擎包 dist。fail-closed：都不在场返回 null（bridge 显式报错）。 */
function resolveSidecarPath(): string | null {
  const envDir = process.env.FREECODEZ_CUA_ENGINE_SIDECAR?.trim();
  if (envDir && process.env.FREECODEZ_CUA_ENGINE_READY === "1") {
    const fromEnv = join(envDir, "computer-sidecar.js");
    if (existsSync(fromEnv)) return fromEnv;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  // Electron Helper-as-node 下指向 app Resources；纯 node（CLI/测试面）为 undefined。
  const resourcesPath = (process as typeof process & { resourcesPath?: string }).resourcesPath;
  const candidates = sidecarCandidatePaths({ here, resourcesPath });
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** sidecar 候选路径（纯函数，测试直测）。三级布局：
 * - 打包态（G1，2026-10-11 装机审计修复）：server 从插件缓存跑
 *   （…/cache/freecodez/node-repl-host/<ver>/dist/mcp），相对候选全够不着——锚定
 *   process.resourcesPath（node_repl 由 Electron Helper-as-node 拉起，resourcesPath
 *   指向 app Resources，与 prepare-agent-node-bundle 的 glm/packages/computer-engine-dist
 *   staging 布局对齐）。缓存换版本也不受影响（读 app 资产而非缓存副本）。
 * - 打包 staging 布局（dist→node-repl-host→packages→根，包旁 computer-engine-dist）。
 * - 开发态（src→node-repl-host→packages→zcode-cli→apps→根，或 dev 构建产物 dist/mcp
 *   →上五层=apps→packages/computer-engine/dist）。 */
export function sidecarCandidatePaths(input: {
  here: string;
  resourcesPath?: string | undefined;
}): string[] {
  const { here, resourcesPath } = input;
  const packaged = resourcesPath
    ? [join(resourcesPath, "glm", "packages", "computer-engine-dist", "computer-sidecar.js")]
    : [];
  return [
    ...packaged,
    resolve(here, "../../computer-engine-dist/computer-sidecar.js"),
    resolve(here, "../../../../../packages/computer-engine/dist/computer-sidecar.js"),
    resolve(here, "../../../packages/computer-engine/dist/computer-sidecar.js"),
  ];
}

/** W-28/P3（V1.19）：光标 HUD 帧出口——SDK 输入事件旁路单播到本机 HUD 监听
 * （desktop cuaCursorHud 绑 127.0.0.1:53717；FREECODEZ_CUA_CURSOR_BROADCAST_PORT 可覆盖）。
 * 惰性建 socket；发送失败静默吞（可视化旁路不折断动作本体，同 emitCursorEvents 口径）。 */
export function createCursorHudBroadcaster(
  env: NodeJS.ProcessEnv = process.env,
): { emit(event: unknown): void; close(): void } {
  const port = Number(env.FREECODEZ_CUA_CURSOR_BROADCAST_PORT) || 53717;
  let socket: Socket | undefined;
  return {
    emit(event: unknown) {
      try {
        socket ??= createSocket("udp4");
        socket.send(JSON.stringify(event), port, "127.0.0.1");
      } catch {
        // 旁路可视化：发送失败不影响动作。
      }
    },
    close() {
      try {
        socket?.close();
      } catch {
        // 双 close 防御。
      }
      socket = undefined;
    },
  };
}

export function createComputerBridgeGlobals(input: {
  generation: number;
  getActiveCall: () => ActiveComputerCall | undefined;
  session: () => ComputerBridgeSession;
}): Record<PropertyKey, unknown> {
  let harness: SidecarHarness | undefined;
  let sdk: unknown;
  // W-28/P3：HUD 帧广播器随桥生命周期（dispose 收口关 socket）。
  const cursorHud = createCursorHudBroadcaster();
  // P4b：最近上报的 CUA 目标应用（display.targetApp 来源——图标定位与卡片标题）。
  let lastCuaApp: { pid: number; name: string; bundleId?: string } | undefined;

  const assertAvailable = (): ActiveComputerCall => {
    const active = input.getActiveCall();
    if (!active || active.generation !== input.generation) {
      throw new Error("Computer runtime binding is stale after kernel reset");
    }
    if (active.runtimeScope === "subagent") {
      throw new Error(COMPUTER_UNAVAILABLE_IN_SUBAGENT_MESSAGE);
    }
    return active;
  };

  const ensureSdk = (): Promise<unknown> => {
    assertAvailable();
    // 生效链门（V1.17）：桌面设置总开关关 → bootstrap 注入 FREECODEZ_CUA_DISABLED。
    // 显式产品开关拒绝优先于产物检查——报「设置关闭」而不是「引擎未构建」，
    // 模型才能把正确的处置转告用户（去设置开启），而不是误判为装机缺陷。
    if (process.env.FREECODEZ_CUA_DISABLED === "1") {
      throw new Error(
        "Computer use is turned off in FreeCodeZ settings. Do not retry; tell the user to enable 电脑操作 (Computer Use) in Settings → 计算机控制 and start a new session.",
      );
    }
    if (sdk) return Promise.resolve(sdk);
    const sidecarPath = resolveSidecarPath();
    if (!sidecarPath) {
      throw new Error(
        "Computer engine sidecar is not built. Run node packages/computer-engine/scripts/build-sidecar.mjs first.",
      );
    }
    const active = assertAvailable();
    return createSidecarHarness({ sidecarPath }).then((started) => {
      harness = started;
      // G3：docs 随 sidecar 产物走（build-sidecar 拷 docs/app-instructions 进 dist）。
      // SDK 已被 esbuild 内联进本 bundle，其模块相对根失效，由这里从真实产物目录推导。
      const docsRoot = join(dirname(sidecarPath), "docs", "app-instructions");
      return createEngineSdk({
        transport: {
          request: (method: string, params?: Record<string, unknown>) =>
            started.request(method, params),
        },
        sessionId: active.sessionId,
        // 动作层设置门（V1.19 P1）：bootstrap 注入 FREECODEZ_CUA_ACTIONS=0 → SDK 拒
        // 动作面（actions_disabled）、观测面豁免。缺省不设门（headless CLI）。
        actionsEnabled: process.env.FREECODEZ_CUA_ACTIONS !== "0",
        // 光标 HUD 帧出口（V1.19 P3）：SDK 输入事件旁路单播 127.0.0.1:53717。
        onInputEvent: (event: unknown) => cursorHud.emit(event),
        // 观测目标身份上报（V1.19 P4，W-30/S6 重建）：真实引擎快照解析（防自报伪造），
        // 经 responseMeta 下行（_meta 通道）→ 行装配盖 toolCallRow.cuaApp → UI 分组/图标。
        onCuaApp: (app: { pid: number; name: string; bundleId?: string }) => {
          lastCuaApp = app;
          input.session().mergeResponseMeta({ "freecodez/nodeReplCuaApp": app });
        },
        // P4b（display 复产）：每次 SDK 操作经 buildCuaToolDisplay 投影 kind:"cua"
        // display → responseMeta 下行 → executor 透传 → UI 渲染器换源消费。同步旁路
        // （回调内完成投影与下行；异步会把 display 落进错误的 run 上下文）。
        onCuaOperation: (op: {
          method: string;
          ok: boolean;
          errorCode?: string;
          result?: unknown;
          params?: Record<string, unknown>;
        }) => {
          const display = buildCuaToolDisplay({
            toolName: op.method,
            status: op.ok ? "success" : "failed",
            ...(op.result !== undefined ? { result: op.result } : {}),
            ...(op.errorCode !== undefined ? { errorCode: op.errorCode } : {}),
            ...(op.params !== undefined ? { params: op.params } : {}),
            ...(lastCuaApp
              ? {
                  targetApp: {
                    ...(lastCuaApp.name ? { displayName: lastCuaApp.name } : {}),
                    ...(lastCuaApp.bundleId ? { bundleId: lastCuaApp.bundleId } : {}),
                  },
                }
              : {}),
          });
          input.session().mergeResponseMeta({ "freecodez/nodeReplCuaDisplay": display });
        },
        ...(existsSync(docsRoot) ? { docsRoot } : {}),
      }).then((created) => {
        sdk = created;
        return created;
      });
    });
  };

  const dispose = async () => {
    await harness?.stop();
    cursorHud.close();
    harness = undefined;
    sdk = undefined;
  };

  return {
    [NODE_REPL_COMPUTER_BRIDGE_SYMBOL]: {
      assertAvailable,
      // G3：docs 根改为从解析到的 sidecar 产物目录惰性推导（bundle 后模块相对深度失效）。
      get documentationRoot(): string {
        const sidecarPath = resolveSidecarPath();
        return sidecarPath
          ? resolve(dirname(sidecarPath), "docs")
          : resolve(
              dirname(fileURLToPath(import.meta.url)),
              "../../../../packages/computer-engine/docs",
            );
      },
      sdk: ensureSdk,
      /** 进程收尾：sidecar SIGTERM（provider teardown 由 sidecar handler 承担）。 */
      dispose,
    },
    // 模型面引导函数（与 Browser Use 的 setupBrowserRuntime 同构）：
    // `const computer = await setupComputerUseRuntime();`——零 import，直接可调。
    setupComputerUseRuntime: ensureSdk,
  };
}
