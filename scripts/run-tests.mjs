// A2 统一测试入口：按"最近 package.json"分组发现全部 *.test.ts，逐包以
// 该包目录为 cwd、注册该包 tsconfig（TSX_TSCONFIG_PATH）后经 node:test 运行。
// 背景：各包测试运行要求不一——packages/ui 用 "@/*" 别名需要 TSX_TSCONFIG_PATH，
// 另有测试以包内相对路径读 fixture 依赖 cwd；从仓库根裸跑会随机踩中其一。
// 任一包失败即非零退出；汇总各包通过/失败数。
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXCLUDE_DIRS = new Set(["node_modules", "dist", "upstream-assets-3.14.3", ".git"]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      yield join(dir, entry.name);
    }
  }
}

function nearestPackageRoot(file) {
  let dir = dirname(file);
  while (dir !== repoRoot) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return repoRoot;
}

const groups = new Map();
for (const file of walk(repoRoot)) {
  const root = nearestPackageRoot(file);
  if (!groups.has(root)) groups.set(root, []);
  groups.get(root).push(relative(root, file));
}

// 只跑存在测试的包；desktop 等含原生依赖的包若失败会在汇总中如实报告。
const results = [];
for (const [root, files] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const env = { ...process.env };
  const tsconfig = join(root, "tsconfig.json");
  if (existsSync(tsconfig)) env.TSX_TSCONFIG_PATH = tsconfig;
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", ...files],
    { cwd: root, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const failed = run.status !== 0;
  results.push({ root: relative(repoRoot, root) || ".", files: files.length, failed });
  const label = `# [${results.length}/${groups.size}] ${relative(repoRoot, root) || "."}（${files.length} 个测试文件）`;
  console.log(`${label} ${failed ? "FAIL" : "PASS"}`);
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
}

const failed = results.filter((r) => r.failed);
console.log(`\n测试汇总：${results.length} 个包 / ${results.reduce((n, r) => n + r.files, 0)} 个测试文件；失败包 ${failed.length}${failed.length ? "：" + failed.map((f) => f.root).join(", ") : ""}`);
process.exit(failed.length ? 1 : 0);
