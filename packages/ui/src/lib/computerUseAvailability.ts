// FreeCodeZ W-18：电脑控制可用性判定（FC 自有件）。D2 三平台硬性——mac/win/linux
// 本地桌面全支持（含 local-linux，旧 false 门按引擎 handshake 依赖探测动态判定后开启）；
// 远程会话（web/remote workspace）不支持本地电脑控制。
export type ComputerUseAvailability =
  | { supported: true }
  | { supported: false; reason: "remote" | "unsupported-platform" };

export function resolveComputerUseAvailability(input: {
  isDesktop: boolean;
  platform?: string;
}): ComputerUseAvailability {
  if (!input.isDesktop) {
    return { supported: false, reason: "remote" };
  }
  const platform = input.platform ?? "unknown";
  if (platform === "darwin" || platform === "win32" || platform === "linux") {
    return { supported: true };
  }
  return { supported: false, reason: "unsupported-platform" };
}
