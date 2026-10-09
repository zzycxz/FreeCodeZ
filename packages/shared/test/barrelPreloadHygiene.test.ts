// preload 卫生门（2026-10-07，248dbaf 白屏两连发后的结构性防线）：
// desktop 沙箱 preload 经 tsup noExternal 内联整个 @zcode/shared barrel（index.ts 的
// export * 链），esbuild 摇不掉未用导入——barrel 可达图里任何 node: 原生模块或未内联的
// 外部包，都会以 require(...) 死代码进 preload bundle，沙箱（只许 require electron）
// 模块初始化即炸 → contextBridge 不执行 → 渲染进程 window 桥缺失 → 打包态白屏。
// 两发事故：git-hunks→node:crypto（248dbaf）、runtimeEnv→@zcode/zcode-cua（本条）。
// 涉事模块的解法都是"退出 barrel、改子路径导出"；本测试保证第三发进不来。
//
// 允许清单的依据：tsup preload target 的 noExternal = ["@zcode/shared", "zod"]（见
// packages/desktop/tsup.config.ts）——zod 是纯 JS 且明确内联；其余裸导入若出现，除非
// 同步进 noExternal 且确认纯 JS（不引 node: 原生），否则一律视为 preload 炸弹。
//
// 扫描口径（只看会产生运行时 require 的导入）：
// - `import type` / `export type` 整句类型导入编译期擦除，不进模块图，跳过；
// - 动态 import() 是惰性求值，不在加载期炸，跳过（但被调用时的坑归调用方自理）；
// - 静态值导入/副作用导入/再导出 = 加载期 require，全部受检。
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sharedSrc = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
// 允许清单 = preload bundle 里会被"内联而非外部 require"的纯 JS 包：
// - zod：tsup preload noExternal 明确内联（packages/desktop/tsup.config.ts）；
// - @zcode/model-option-map：workspace 纯 JS 包，不在 desktop dependencies（tsup 默认
//   只外部化 dependencies），esbuild 内联进 bundle——2026-10-07 实测 preload require
//   集合仅 electron+zcode-cua 两枚，model-option-map 无 require 形态即内联佐证。
// 新增裸导入必须先确认"内联且纯 JS"（不引 node: 原生）才能加进来；打包态最终以
// tsup preload onSuccess 的 require 断言兜底（out/preload/*.cjs 只许 require electron）。
const INLINEABLE_EXTERNALS = new Set(["zod", "@zcode/model-option-map"]);

/** TS 惯例：源码写 "./x.js"，实体是 ./x.ts。 */
function resolveRelativeTarget(fromFile: string, spec: string): string | undefined {
  const stripped = spec.replace(/\.js$/, "");
  const base = resolve(dirname(fromFile), stripped);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/** 提取加载期 require 的模块说明符（跳过整句类型导入与动态 import）。 */
function runtimeModuleSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const statement =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?[^"'()]*?from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(statement)) {
    if (match[2]) continue; // import type / export type：编译期擦除
    const spec = match[3];
    if (spec) specs.push(spec);
  }
  for (const match of source.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) {
    const spec = match[1];
    if (spec) specs.push(spec); // 副作用导入
  }
  return specs;
}

function collectBarrelReachableFiles(): string[] {
  const visited = new Set<string>();
  const queue = [join(sharedSrc, "index.ts")];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const spec of runtimeModuleSpecifiers(source)) {
      if (!spec.startsWith(".")) continue;
      const target = resolveRelativeTarget(file, spec);
      if (target) queue.push(target);
    }
  }
  return [...visited].sort();
}

function externalPackageName(spec: string): string {
  if (spec.startsWith("node:")) return spec;
  return spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
}

test("barrel 可达图不得导入 node: 原生或未内联外部包（沙箱 preload 白屏防线）", () => {
  const files = collectBarrelReachableFiles();
  // 图非空才有意义（防扫描器静默失配变成假绿）。
  assert.ok(files.length > 20, `barrel 可达图过小(${files.length})，扫描器疑似失效`);
  const violations: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const spec of runtimeModuleSpecifiers(source)) {
      if (spec.startsWith(".")) continue;
      const pkg = externalPackageName(spec);
      if (pkg.startsWith("node:") || !INLINEABLE_EXTERNALS.has(pkg)) {
        violations.push(`${file.slice(sharedSrc.length + 1)} → ${spec}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `barrel 可达图含 preload 炸弹导入（涉事模块须退出 barrel 改子路径导出，参考 index.ts git-hunks/runtimeEnv 注释）：\n${violations.join("\n")}`,
  );
});

test("涉事历史模块保持 barrel 之外（防误加回）", () => {
  const index = readFileSync(join(sharedSrc, "index.ts"), "utf8");
  assert.ok(
    !/export\s+\*\s+from\s+["']\.\/(?:git-hunks|runtimeEnv)\.js["']/.test(index),
    "git-hunks/runtimeEnv 不得回 barrel（248dbaf/2026-10-07 白屏事故源）",
  );
  // 子路径导出必须保留（消费方 @zcode/shared/runtime-env / /git-hunks 在用）。
  const pkg = JSON.parse(readFileSync(join(sharedSrc, "..", "package.json"), "utf8"));
  assert.equal(pkg.exports["./runtime-env"], "./src/runtimeEnv.ts");
  assert.equal(pkg.exports["./git-hunks"], "./src/git-hunks.ts");
});

test("sanity：扫描器真的遍历到了 index.ts（防 glob 回归假绿）", () => {
  const files = collectBarrelReachableFiles();
  assert.ok(files.includes(join(sharedSrc, "index.ts")), "可达图应包含 index.ts 本身");
  assert.ok(
    files.some((file) => file.endsWith("mcp.ts")),
    "可达图应包含 index.ts 直接再导出的模块（如 mcp.ts）",
  );
});
