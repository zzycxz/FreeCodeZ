// ============================================================
// 电脑控制设置桥（CUA koffi 双门的产品面收口）
// ============================================================
// 双门的分层思想保留（观察/操作两档信任，对应系统「屏幕录制/辅助功能」心智），
// 但 env 不是用户入口：设置页两个键优先，env（ZCODE_CUA_KOFFI_EXECUTION/ACTIONS）
// 降级为部署/开发覆盖——与 Appshot（设置优先 env 兜底）同一条先例。
// 桥接通道：runtimeProcessEnvPreparation 的异步 env 补丁（每窗口刷新、先于
// host spawn 合入 host process.env，host 的 agent/node-repl-host 子进程继承），
// 因此设置变更对新窗口的会话生效；env 键显式写 "1"/"0"（settings 显式关闭
// 必须压过继承的 =1，Object.assign 无法删键，用 "0" 等效关闭——消费端只认 "1"）。
import { CUA_CURSOR_HUD_UDP_PORT } from "./cuaCursorHud.js";

export const CUA_CONTROL_EXECUTION_ENV = "ZCODE_CUA_KOFFI_EXECUTION";
export const CUA_CONTROL_ACTIONS_ENV = "ZCODE_CUA_KOFFI_ACTIONS";
export const CUA_CONTROL_CURSOR_PORT_ENV = "ZCODE_CUA_CURSOR_BROADCAST_PORT";

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
  const execution =
    settings.cuaControlEnabled !== undefined
      ? settings.cuaControlEnabled === true
      : env[CUA_CONTROL_EXECUTION_ENV]?.trim() === "1";
  const actions =
    execution &&
    (settings.cuaActionsEnabled !== undefined
      ? settings.cuaActionsEnabled === true
      : env[CUA_CONTROL_ACTIONS_ENV]?.trim() === "1");
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
