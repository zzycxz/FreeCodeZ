#!/usr/bin/env node
// FreeCodeZ 构建脚本（非 orca 原件）：sidecar 独立产物装配（W-10）。
// 语义对齐 orca electron.vite.config.ts 的 computer-sidecar 入口（plain-node 入口、
// 零 Electron 依赖），用 esbuild 打成单文件供 fork 驱动（A3 冒烟目标产物）。
import { mkdirSync } from "node:fs";
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

console.log(`[computer-engine] sidecar built: ${outfile}`);
