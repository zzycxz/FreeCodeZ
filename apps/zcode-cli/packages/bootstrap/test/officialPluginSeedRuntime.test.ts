// 2026-10-07 第五发包态盲区回归：node-repl-host 的 seed 必须携带 node_modules。
// 运行副本是 seed 缓存（rootPath 走 scanOfficialCache，见 plugins list 实测），server.js
// 内联的 koffi-ax 用 createRequire(import.meta.url) 从缓存副本解析 require("koffi")——
// 缺 node_modules 时 MODULE_NOT_FOUND 被 try/catch 吞掉 → bindings=null →
// 电脑控制执行层静默消失（dev 态靠仓库根 hoisted node_modules 蒙对，只有包态炸）。
// 本测试把 runtimeTopLevelPaths 开关钉死：涉 native 运行时的插件条目不得置空。
import assert from "node:assert/strict";
import test from "node:test";
import {
  OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME,
  OFFICIAL_PLUGIN_DEFINITIONS,
} from "../src/app/official-plugin-definitions.js";

// 需要随 seed 携带 node_modules 的插件：执行进程从各自 rootPath 解析原生依赖。
// - node-repl-host：server.js 内联 koffi-ax require("koffi")（电脑控制执行层）；
// - computer-use：SDK 脚本 require("sharp")（截图/缩放链）。
const NATIVE_RUNTIME_PLUGINS = [OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME, "computer-use"];

test("native 运行时插件的 seed 定义必须携带 node_modules", () => {
  for (const name of NATIVE_RUNTIME_PLUGINS) {
    const definition = OFFICIAL_PLUGIN_DEFINITIONS.find((item) => item.name === name);
    assert.ok(definition, `official plugin 定义缺失: ${name}`);
    assert.ok(
      definition.runtimeTopLevelPaths?.includes("node_modules"),
      `${name} 的 runtimeTopLevelPaths 必须含 "node_modules"（置空=缓存副本缺 koffi/sharp，` +
        `执行层 try/catch 静默降级，包态电脑控制消失；参考 computer-use 条目“勿再置空”注释）`,
    );
  }
});

test("sanity：定义表非空且 node-repl-host 在场", () => {
  assert.ok(OFFICIAL_PLUGIN_DEFINITIONS.length > 5);
  assert.ok(
    OFFICIAL_PLUGIN_DEFINITIONS.some((item) => item.name === OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME),
  );
});
