// B1-6(电脑控制能力补位):Computer Use Helper 安装验签锚点(ZCODE_CUA_HELPER_BUILD_ID)。
// 空值在正式包会被 helperInstaller fail-closed 拒绝("missing its embedded Computer Use
// Helper build identity");desktop tsup 与 node-repl-host esbuild 两处 define 必须同源,
// 故收敛到本模块:env 覆盖优先,缺省用 vendored helper 的版本构造本地构建 ID。
//
// R21c 修补(2026-10-09 真机盲区):版本派生兜底对同版本重建永不漂移——helper 代码变了
// identity.json 仍同值,ensureInstalled「无漂移」判定留任旧 helper(一次性权限请求
// --request-permissions 拿到不认识该旗标的旧件,权限条目建不出来,用户侧表现=系统权限列表
// 永远没有 FreeCodeZ Computer Use 行)。兜底改为**内容派生**:sha256(packages/zcode-cua
// 全部源码+package.json,路径排序),代码一变 buildId 即漂移 → ensureInstalled 重装换血。
// 显式 env 覆盖(FREECODEZ_CUA_HELPER_BUILD_ID)语义不变;sourceRoot 参数仅测试注入用。
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function collectSourceFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "test" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, files);
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name === "package.json")) {
      files.push(full);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

export function resolveCuaHelperBuildId(env = process.env, sourceRoot) {
  const explicit = (env.FREECODEZ_CUA_HELPER_BUILD_ID ?? env.ZCODE_CUA_HELPER_BUILD_ID)?.trim();
  if (explicit) return explicit;
  const packageRoot = sourceRoot ?? join(repoRoot, "packages", "zcode-cua");
  const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
  const hash = createHash("sha256");
  for (const file of collectSourceFiles(packageRoot)) {
    hash.update(file.slice(packageRoot.length));
    hash.update(readFileSync(file));
  }
  return `local-${version}-${hash.digest("hex").slice(0, 12)}`;
}
