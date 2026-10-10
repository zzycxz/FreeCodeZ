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
  // 布局两形态：开发态 src/ 在五层深处（src→node-repl-host→packages→zcode-cli→apps→根）；
  // 打包态编译产物 dist/ 在三层深处（dist→node-repl-host→packages→根，包随 seed 布局）。
  const candidates = [
    resolve(here, "../../computer-engine-dist/computer-sidecar.js"),
    resolve(here, "../../../../../packages/computer-engine/dist/computer-sidecar.js"),
    resolve(here, "../../../packages/computer-engine/dist/computer-sidecar.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
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
      return createEngineSdk({
        transport: {
          request: (method: string, params?: Record<string, unknown>) =>
            started.request(method, params),
        },
        sessionId: active.sessionId,
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
      documentationRoot: resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../packages/computer-engine/docs",
      ),
      sdk: ensureSdk,
      /** 进程收尾：sidecar SIGTERM（provider teardown 由 sidecar handler 承担）。 */
      dispose,
    },
    // 模型面引导函数（与 Browser Use 的 setupBrowserRuntime 同构）：
    // `const computer = await setupComputerUseRuntime();`——零 import，直接可调。
    setupComputerUseRuntime: ensureSdk,
  };
}
