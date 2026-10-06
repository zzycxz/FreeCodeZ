// ============================================================
// 电脑控制设置桥（CUA koffi 双门的产品面收口）
// ============================================================
// 双门的分层思想保留（观察/操作两档信任，对应系统「屏幕录制/辅助功能」心智），
// 但 env 不是用户入口：设置页两个键优先，env（FREECODEZ_CUA_KOFFI_EXECUTION/ACTIONS，旧键
// ZCODE_* 仍可作部署/开发覆盖）——与 Appshot（设置优先 env 兜底）同一条先例。
// 桥接通道：runtimeProcessEnvPreparation 的异步 env 补丁（每窗口刷新、先于
// host spawn 合入 host process.env，host 的 agent/node-repl-host 子进程继承），
// 因此设置变更对新窗口的会话生效；env 键显式写 "1"/"0"（settings 显式关闭
// 必须压过继承的 =1，Object.assign 无法删键，用 "0" 等效关闭——消费端只认 "1"）。
import { CUA_CURSOR_HUD_UDP_PORT } from "./cuaCursorHud.js";

// 条目 1 契约新键改名收口：主键 FREECODEZ_*，旧键 ZCODE_* 作为部署/开发覆盖的回退读名。
// 写侧（resolveCuaControlHostEnv）只写主键——消费端（node-repl-host server.ts）主键优先读，
// 桥写的 "0" 仍能压过继承的旧键 =1（显式关闭语义不变）。
export const CUA_CONTROL_EXECUTION_ENV = "FREECODEZ_CUA_KOFFI_EXECUTION";
export const CUA_CONTROL_ACTIONS_ENV = "FREECODEZ_CUA_KOFFI_ACTIONS";
export const CUA_CONTROL_CURSOR_PORT_ENV = "FREECODEZ_CUA_CURSOR_BROADCAST_PORT";
export const CUA_CONTROL_EXECUTION_ENV_LEGACY = "ZCODE_CUA_KOFFI_EXECUTION";
export const CUA_CONTROL_ACTIONS_ENV_LEGACY = "ZCODE_CUA_KOFFI_ACTIONS";
export const CUA_CONTROL_CURSOR_PORT_ENV_LEGACY = "ZCODE_CUA_CURSOR_BROADCAST_PORT";

export interface CuaControlSettingsShape {
  cuaControlEnabled?: boolean;
  cuaActionsEnabled?: boolean;
}

/**
 * 双门判定（纯函数）：设置键**已定义**则用户意图胜出（显式 false 也要压过 env=1）；
 * 未定义回落 env。动作门蕴含观测门（execution=false 时 actions 恒 false）。
 */
export function resolveCuaControlGates(input: {
  settings?: CuaControlSettingsShape;
  env?: Record<string, string | undefined>;
}): { execution: boolean; actions: boolean } {
  const settings = input.settings ?? {};
  const env = input.env ?? {};
  // 双读：主键空值视同未设，回落旧键（与 bundle.mjs FREECODEZ_DEPS_BASE_URL 同款模式）。
  const executionEnv =
    env[CUA_CONTROL_EXECUTION_ENV]?.trim() || env[CUA_CONTROL_EXECUTION_ENV_LEGACY]?.trim();
  const actionsEnv =
    env[CUA_CONTROL_ACTIONS_ENV]?.trim() || env[CUA_CONTROL_ACTIONS_ENV_LEGACY]?.trim();
  const execution =
    settings.cuaControlEnabled !== undefined
      ? settings.cuaControlEnabled === true
      : executionEnv === "1";
  const actions =
    execution &&
    (settings.cuaActionsEnabled !== undefined ? settings.cuaActionsEnabled === true : actionsEnv === "1");
  return { execution, actions };
}

/**
 * 子进程 env 补丁：三个键总是显式给值（"1"/"0"）——settings 显式关闭要压过
 * 继承 env 的 =1，assign 删不了键就用 "0"（消费端 server.ts 只认 "1"）。
 * 动作门开且 HUD 在听（darwin）时注入广播端口，光标可视化随之打通。
 */
export function resolveCuaControlHostEnv(input: {
  settings?: CuaControlSettingsShape;
  env?: Record<string, string | undefined>;
  darwin?: boolean;
  cursorHudActive?: boolean;
}): Record<string, string> {
  const gates = resolveCuaControlGates(input);
  const darwin = input.darwin ?? false;
  const execution = gates.execution && darwin;
  const actions = gates.actions && darwin;
  return {
    [CUA_CONTROL_EXECUTION_ENV]: execution ? "1" : "0",
    [CUA_CONTROL_ACTIONS_ENV]: actions ? "1" : "0",
    // 非 darwin / 动作关：写 "0" 显式失效（防继承端口在无 HUD 宿主上空播）。
    [CUA_CONTROL_CURSOR_PORT_ENV]:
      actions && (input.cursorHudActive ?? true) ? String(CUA_CURSOR_HUD_UDP_PORT) : "0",
  };
}
