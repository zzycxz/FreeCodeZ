#!/usr/bin/env node
// FreeCodeZ 构建脚本（非 orca 原件）：sidecar 独立产物装配（W-10）。
// 语义对齐 orca electron.vite.config.ts 的 computer-sidecar 入口（plain-node 入口、
// 零 Electron 依赖），用 esbuild 打成单文件供 fork 驱动（A3 冒烟目标产物）。
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(pkgRoot, "dist", "computer-sidecar.js");
mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [join(pkgRoot, "src", "main", "computer", "sidecar-entry.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  logLevel: "warning",
});

// G3（2026-10-11 装机审计）：docs/app-instructions 随 dist 走。SDK 被 esbuild 内联进
// node_repl server bundle 后源码相对根失效，运行时由桥面从 sidecar 产物目录推导
//（<dist>/docs/app-instructions），因此 dist 必须自含该资产。
const docsSource = join(pkgRoot, "docs", "app-instructions");
const docsTarget = join(pkgRoot, "dist", "docs", "app-instructions");
if (existsSync(docsSource)) {
  rmSync(docsTarget, { recursive: true, force: true });
  cpSync(docsSource, docsTarget, { recursive: true });
  console.log(`[computer-engine] docs staged into dist: ${docsTarget}`);
} else {
  console.warn(`[computer-engine] docs source missing (skip staging): ${docsSource}`);
}

console.log(`[computer-engine] sidecar built: ${outfile}`);
