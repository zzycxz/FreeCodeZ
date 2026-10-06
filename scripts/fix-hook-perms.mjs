// 修复 .husky/_ 下 shim 的执行位。
// 背景：本仓 node_modules/.husky 曾从 Windows 同步（丢执行位），git core.hooksPath 指向
// .husky/_——shim 无 x 位时 git 静默忽略所有钩子，pre-push 全门禁（verify:pre-push）失效。
// 挂在 root package.json 的 prepare（"husky && node scripts/fix-hook-perms.mjs"）之后跑，
// 保证 husky 重新生成 .husky/_ 后权限也被修正。
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const shimDir = join(rootDir, ".husky", "_");

if (!existsSync(shimDir)) {
  process.exit(0);
}

let fixed = 0;
for (const name of readdirSync(shimDir)) {
  const target = join(shimDir, name);
  if (!statSync(target).isFile()) continue;
  try {
    chmodSync(target, 0o755);
    fixed += 1;
  } catch {
    // 尽力而为：个别文件失败不阻塞 install
  }
}
console.log(`[fix-hook-perms] .husky/_ ${fixed} 个 shim 执行位已确认`);
