// FreeCodeZ 桥（W-19）：运行时接 @zcode/computer-engine 权限面。
// JS 形态 + d.ts 配对：引擎源为 bundler 解析（无扩展名 ESM），desktop main 是
// nodenext——经本桥隔离，引擎源不进 desktop 类型程序（TS2835 面）。
export async function getComputerUsePermissionStatus() {
  const engine = await import("@zcode/computer-engine/computer");
  return engine.getComputerUsePermissionStatus();
}

export async function openComputerUsePermissions(permission) {
  const engine = await import("@zcode/computer-engine/computer");
  return engine.openComputerUsePermissions(permission);
}

export async function resetComputerUsePermissions() {
  const engine = await import("@zcode/computer-engine/computer");
  return engine.resetComputerUsePermissions();
}
