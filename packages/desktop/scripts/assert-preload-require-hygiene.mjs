#!/usr/bin/env node
/* 沙箱 preload require 卫生断言（2026-10-07，248dbaf 白屏两连发的构建期兜底）。
 *
 * desktop 沙箱 preload 只允许 require("electron")——其它任何 require 都会在模块初始化
 * 期炸掉（contextBridge 不执行 → 渲染进程 window 桥缺失 → 打包态白屏）。两发事故都是
 * barrel 链把 node-only 依赖拖进 preload bundle：
 *   - git-hunks → require("crypto")（248dbaf）
 *   - runtimeEnv → 电脑控制复刻包（2026-10-07）
 * 源码级防线见 packages/shared/test/barrelPreloadHygiene.test.ts；本脚本在 tsup preload
 * 构建完成后对产物做最终断言，不满足即让构建失败。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const preloadOut = resolve(dirname(fileURLToPath(import.meta.url)), "..", "out", "preload");

const ALLOWED_REQUIRE_TARGETS = new Set(["electron"]);

function collectRequireTargets(source) {
  const targets = new Set();
  for (const match of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
    const target = match[1];
    if (target) targets.add(target);
  }
  return targets;
}

let checked = 0;
const violations = [];
for (const entry of readdirSync(preloadOut)) {
  if (!entry.endsWith(".cjs")) continue;
  checked += 1;
  const file = join(preloadOut, entry);
  const source = readFileSync(file, "utf8");
  for (const target of collectRequireTargets(source)) {
    if (!ALLOWED_REQUIRE_TARGETS.has(target)) {
      violations.push(`${entry} → require("${target}")`);
    }
  }
}

if (checked === 0) {
  console.error(`[assert-preload-require-hygiene] no .cjs entries found in ${preloadOut} (scanning failure?)`);
  process.exit(1);
}
if (violations.length > 0) {
  console.error(
    "[assert-preload-require-hygiene] 沙箱 preload 产物包含非 electron require（加载即炸→白屏）：",
  );
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error(
    "  修复方向：涉事模块退出 @zcode/shared barrel 改子路径导出（参考 index.ts 内 git-hunks/runtimeEnv 注释）；",
  );
  console.error(
    "  或将纯 JS 包加入 tsup preload noExternal 内联名单（严禁 node: 原生依赖）。",
  );
  process.exit(1);
}
console.log(
  `[assert-preload-require-hygiene] OK: ${checked} preload bundles, require targets ⊆ {${[...ALLOWED_REQUIRE_TARGETS].join(", ")}}`,
);
