// FreeCodeZ fork(电脑控制能力补位 B2):权限端口真实现。
// shouldRunCuaScreenCaptureProbe 的隐私语义(R6 fail-closed)不得弱化:
// 调用方省略 probeScreenCapture 时绝不主动抓屏;显式 false 也绝不抓;只有显式 true 且
// 权限状态可用时才允许跑探针。

export function isCuaPermissionStatusAvailable(result) {
  return Boolean(result) && typeof result === "object" && result.available === true;
}

export function shouldRunCuaScreenCaptureProbe(state, options = {}) {
  if (options.probeScreenCapture !== true) return false;
  return state === "granted" || state === "stale" || state === "denied" || state === "unknown";
}
