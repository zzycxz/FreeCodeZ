// FreeCodeZ W-14 桥接（S1-S5 缝替换，FC 自有件）：node_repl 进程内暴露新引擎 SDK。
// 旧栈（cua-bridge.ts Symbol.for broker 客户端）已随 W-03 拆除；本件按 browser-bridge
// 同构模式重建：Symbol.for 全局 + 懒启动 sidecar + subagent 拒绝（三外沿保留）。
// 引擎经 engine-bridge（JS+d.ts）隔离接入——nodenext 与 bundler 解析边界的既定先例。
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeReplRequestMeta } from "@zcode/core/repl";
import {
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

export function createComputerBridgeGlobals(input: {
  generation: number;
  getActiveCall: () => ActiveComputerCall | undefined;
  session: () => ComputerBridgeSession;
}): Record<PropertyKey, unknown> {
  let harness: SidecarHarness | undefined;
  let sdk: unknown;

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
        ...(existsSync(docsRoot) ? { docsRoot } : {}),
      }).then((created) => {
        sdk = created;
        return created;
      });
    });
  };

  const dispose = async () => {
    await harness?.stop();
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
