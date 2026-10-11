// 【时序修复·必读】zod classic 在 esbuild 内联 bundle 里的懒初始化时序洞。
//
// 现象：node_repl MCP server（dist/mcp/server.js）启动即抛
//   TypeError: ZodLazy is not a constructor（模块求值阶段，MCP 握手 probe 前进程就死）
// → MCP 连接失败、注册 0 工具，会话里模型完全看不到 js 工具，CUA/浏览器桥全不可达。
//
// 根因（bundle 结构实证）：zod/v4/classic/schemas.js 有包内循环 import，esbuild 把它的
// 模块体包进 __esm 懒初始化包装（init_schemas2），但把其中的 function 声明（lazy/union/
// string2/…）提升到包装外；ZodLazy 等类绑定在包装体内赋值。@modelcontextprotocol/core
// 的 auth chunk 在**模块顶层**就调用 z.lazy(...) 构造 JSONValueSchema——调到的是提升出
// 来的 lazy 函数，esbuild 不为提升函数插 init_schemas2()，此刻包装体未执行、ZodLazy 还是
// undefined，于是 new ZodLazy(...) 直接炸。
//
// 修复：在所有模块顶层代码之前引用 zod 的**类绑定** ZodLazy（非提升函数）——esbuild 会
// 据此在本模块体前插入 init_schemas2()（含 init_core2 等整条初始化链），抢先完成 zod
// classic 初始化，之后任何顶层 lazy()/union() 调用都安全。
//
// ⚠ 顺序敏感：本模块必须是 server.ts 的第一个 import（保证其模块体先于 auth chunk 求值）。
import { ZodLazy } from "zod";

// 顶层副作用（throw 守卫）不可被 tree-shake 掉；同时 fail-fast 校验初始化真的发生了。
if (typeof ZodLazy !== "function") {
  throw new Error("zod classic eager init failed: ZodLazy is not initialized");
}
