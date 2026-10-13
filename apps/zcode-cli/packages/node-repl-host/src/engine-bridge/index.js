// FreeCodeZ 桥（W-14）：运行时接 @zcode/computer-engine SDK 面。
// JS 形态 + d.ts 配对：引擎源为 bundler 解析（无扩展名 ESM），本包是 nodenext——
// 经本桥隔离，引擎源不进本包类型程序（TS2835 面；desktop cua-runtime/engine-bridge 同款先例）。
// P4b：buildCuaToolDisplay 走静态导入再导出——SDK 操作上报是同步旁路（fire-and-forget），
// 动态 import 的 Promise 会让 display 落进错误的 run 上下文；d.ts 配对依旧只暴露形状。
import { buildCuaToolDisplay } from "@zcode/computer-engine";

export { buildCuaToolDisplay };

export async function createEngineSdk(options) {
  const engine = await import("@zcode/computer-engine");
  return new engine.ComputerUseSdk(options);
}

export async function createSidecarHarness(options) {
  const engine = await import("@zcode/computer-engine/host/sidecar-harness.js");
  return new engine.ComputerSidecarHarness(options);
}
