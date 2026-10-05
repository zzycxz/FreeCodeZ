// B1-6(电脑控制能力补位):Computer Use Helper 安装验签锚点(ZCODE_CUA_HELPER_BUILD_ID)。
// 空值在正式包会被 helperInstaller fail-closed 拒绝("missing its embedded Computer Use
// Helper build identity");desktop tsup 与 node-repl-host esbuild 两处 define 必须同源,
// 故收敛到本模块:env 覆盖优先,缺省用 vendored helper 的版本构造本地构建 ID。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveCuaHelperBuildId(env = process.env) {
  const explicit = (env.FREECODEZ_CUA_HELPER_BUILD_ID ?? env.ZCODE_CUA_HELPER_BUILD_ID)?.trim();
  if (explicit) return explicit;
  const zcodeCuaVersion = JSON.parse(
    readFileSync(join(repoRoot, "packages", "zcode-cua", "package.json"), "utf8"),
  ).version;
  return `local-${zcodeCuaVersion}`;
}
