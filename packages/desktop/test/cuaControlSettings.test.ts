// 电脑控制设置桥（CUA koffi 双门产品面）纯件测试：设置键已定义则胜出（显式关
// 也要压过 env=1——assign 删不了键用 "0" 等效）；未定义回落 env；动作蕴含观测。
import assert from "node:assert/strict";
import test from "node:test";
import {
  CUA_CONTROL_ACTIONS_ENV,
  CUA_CONTROL_ACTIONS_ENV_LEGACY,
  CUA_CONTROL_CURSOR_PORT_ENV,
  CUA_CONTROL_EXECUTION_ENV,
  CUA_CONTROL_EXECUTION_ENV_LEGACY,
  resolveCuaControlGates,
  resolveCuaControlHostEnv,
} from "../src/main/cuaControlSettings.js";

const CURSOR_HUD_UDP_PORT = 53717;

test("双门判定：设置已定义胜出；未定义回落 env；动作蕴含观测", () => {
  assert.deepEqual(resolveCuaControlGates({ settings: { cuaControlEnabled: true } }), {
    execution: true,
    actions: false,
  });
  assert.deepEqual(
    resolveCuaControlGates({
      settings: { cuaControlEnabled: true, cuaActionsEnabled: true },
    }),
    { execution: true, actions: true },
  );
  // 显式 false 压过 env=1（用户后来的关闭意图胜出）。
  assert.deepEqual(
    resolveCuaControlGates({
      settings: { cuaControlEnabled: false },
      env: { [CUA_CONTROL_EXECUTION_ENV]: "1", [CUA_CONTROL_ACTIONS_ENV]: "1" },
    }),
    { execution: false, actions: false },
  );
  // 未定义 → env 兜底（部署/开发覆盖通道）。
  assert.deepEqual(
    resolveCuaControlGates({
      env: { [CUA_CONTROL_EXECUTION_ENV]: "1", [CUA_CONTROL_ACTIONS_ENV]: "1" },
    }),
    { execution: true, actions: true },
  );
  // 动作开而观测关：观测被 env 关 → 动作不单独放行。
  assert.deepEqual(
    resolveCuaControlGates({
      env: { [CUA_CONTROL_ACTIONS_ENV]: "1" },
    }),
    { execution: false, actions: false },
  );
  // 全空 → 双关。
  assert.deepEqual(resolveCuaControlGates({}), { execution: false, actions: false });
});

test("双门判定：契约新键改名后的双读回退（旧键 ZCODE_* 仍生效；主键空值回落）", () => {
  // 只给旧键（部署/开发覆盖通道）→ 仍然开门。
  assert.deepEqual(
    resolveCuaControlGates({
      env: {
        [CUA_CONTROL_EXECUTION_ENV_LEGACY]: "1",
        [CUA_CONTROL_ACTIONS_ENV_LEGACY]: "1",
      },
    }),
    { execution: true, actions: true },
  );
  // 新旧键同时给：新键优先（新键空串视同未设回落旧键；非 "1" 值则关门）。
  assert.deepEqual(
    resolveCuaControlGates({
      env: {
        [CUA_CONTROL_EXECUTION_ENV]: "1",
        [CUA_CONTROL_ACTIONS_ENV]: "1",
        [CUA_CONTROL_EXECUTION_ENV_LEGACY]: "0",
        [CUA_CONTROL_ACTIONS_ENV_LEGACY]: "0",
      },
    }),
    { execution: true, actions: true },
  );
  assert.deepEqual(
    resolveCuaControlGates({
      env: {
        [CUA_CONTROL_EXECUTION_ENV]: "0",
        [CUA_CONTROL_EXECUTION_ENV_LEGACY]: "1",
      },
    }),
    { execution: false, actions: false },
    "新键显式 0 压过旧键 1（与设置显式关同一意图胜出语义）",
  );
});

test("host env 补丁：三键恒显式给值；darwin 门；动作开才注入 HUD 广播端口", () => {
  const off = resolveCuaControlHostEnv({ settings: {}, env: {}, darwin: true });
  assert.equal(off[CUA_CONTROL_EXECUTION_ENV], "0");
  assert.equal(off[CUA_CONTROL_ACTIONS_ENV], "0");
  assert.equal(off[CUA_CONTROL_CURSOR_PORT_ENV], "0");

  const observeOnly = resolveCuaControlHostEnv({
    settings: { cuaControlEnabled: true },
    env: {},
    darwin: true,
  });
  assert.equal(observeOnly[CUA_CONTROL_EXECUTION_ENV], "1");
  assert.equal(observeOnly[CUA_CONTROL_ACTIONS_ENV], "0");
  assert.equal(observeOnly[CUA_CONTROL_CURSOR_PORT_ENV], "0", "仅观测无动作不广播");

  const actions = resolveCuaControlHostEnv({
    settings: { cuaControlEnabled: true, cuaActionsEnabled: true },
    env: {},
    darwin: true,
    cursorHudActive: true,
  });
  assert.equal(actions[CUA_CONTROL_ACTIONS_ENV], "1");
  assert.equal(actions[CUA_CONTROL_CURSOR_PORT_ENV], String(CURSOR_HUD_UDP_PORT));

  // 非 darwin：koffi 执行层不存在，双门落 0（env 继承值被显式压掉）。
  const nonDarwin = resolveCuaControlHostEnv({
    settings: { cuaControlEnabled: true, cuaActionsEnabled: true },
    env: {},
    darwin: false,
  });
  assert.equal(nonDarwin[CUA_CONTROL_EXECUTION_ENV], "0");
  assert.equal(nonDarwin[CUA_CONTROL_ACTIONS_ENV], "0");

  // settings 显式关 → "0" 压过继承 env 的 "1"（assign 无法删键的等效关闭）。
  const suppress = resolveCuaControlHostEnv({
    settings: { cuaControlEnabled: false },
    env: { [CUA_CONTROL_EXECUTION_ENV]: "1" },
    darwin: true,
  });
  assert.equal(suppress[CUA_CONTROL_EXECUTION_ENV], "0");
});
