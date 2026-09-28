/* global __ZCODE_CUA_HELPER_BUILD_ID__ */
// Helper 安装/验签锚点(B1-6 编译期 define,desktop tsup 与 node-repl-host esbuild 同名注入)。
// 本模块必须留在 createComputerUseRuntime 的导入闭包内:两处打包守卫都要求锚点值在产物里
// 可见(define 名漂移/被摇掉会让正式包 Helper 安装静默退化成未钉扎安装)。直跑/测试下
// 标识符未定义,typeof 守卫兜空串。
export const EMBEDDED_HELPER_BUILD_ID =
  typeof __ZCODE_CUA_HELPER_BUILD_ID__ === "string" ? __ZCODE_CUA_HELPER_BUILD_ID__ : "";

export function resolveExpectedCuaHelperBuildId() {
  return EMBEDDED_HELPER_BUILD_ID.trim() || null;
}
