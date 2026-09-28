#!/usr/bin/env node
// 移动页 bundle 构建（spec W1）：复用 packages/web 既有 vite 链（不动 web 自身打包配置），
// 仅以独立 outDir/base 产出手机页，供自建 relay 的 /remote/v4 静态服务：
//   node scripts/build-web-remote-mobile-page.mjs
// 输出 packages/web/dist-mobile/（index.html + assets，资源前缀 /remote/v4/）。
// relay 端可覆盖目录：ZCODE_WEB_REMOTE_MOBILE_PAGE_DIR；dev 转发：ZCODE_WEB_REMOTE_MOBILE_PAGE_PROXY。
//
// 兼容说明：packages/web/vite.config.ts 把 d3-path 钉到根 node_modules/d3-path/src/index.js，
// pnpm 隔离布局下根目录没有该传递依赖（只在 .pnpm 下）。这里在脚本层补一个解析到 .pnpm 3.x 的
// alias 覆盖（vite inline resolve 整字段替换，故同时带上 "@" → packages/ui/src），不改既有配置文件。

import { createRequire } from "node:module";
import { readdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(rootDir, "packages", "web");

function resolveD3PathEntry() {
  const preferred = resolve(rootDir, "node_modules/d3-path/src/index.js");
  if (existsSync(preferred)) return preferred;
  const pnpmDir = join(rootDir, "node_modules", ".pnpm");
  const candidates = readdirSync(pnpmDir)
    .filter((name) => name.startsWith("d3-path@3."))
    .sort();
  for (const name of candidates.reverse()) {
    const entry = join(pnpmDir, name, "node_modules", "d3-path", "src", "index.js");
    if (existsSync(entry)) return entry;
  }
  return null;
}

async function loadViteBuild() {
  const require = createRequire(join(webDir, "package.json"));
  const viteEntry = require.resolve("vite");
  const vite = await import(pathToFileURL(viteEntry).href);
  return vite.build;
}

async function main() {
  const build = await loadViteBuild();
  const outDir = process.env.ZCODE_WEB_REMOTE_MOBILE_PAGE_OUTDIR?.trim() || "dist-mobile";
  const d3PathEntry = resolveD3PathEntry();
  // base 固定 /remote/v4/：页面由 relay 的 /remote/v4 挂载，资源前缀保持同源子路径。
  // 输入是独立的 mobile.html（packages/web/mobile.html），不打包 Root/侧栏图。
  await build({
    root: webDir,
    configFile: join(webDir, "vite.config.ts"),
    base: "/remote/v4/",
    logLevel: "info",
    resolve: {
      alias: {
        "@": resolve(rootDir, "packages", "ui", "src"),
        ...(d3PathEntry ? { "d3-path": d3PathEntry } : {}),
      },
    },
    build: {
      outDir,
      emptyOutDir: true,
      rollupOptions: {
        input: { mobile: join(webDir, "mobile.html") },
      },
    },
  });
  // relay 的 /remote/v4 固定回落 index.html；vite 按源文件名产 mobile.html，这里统一改名。
  const outAbs = join(webDir, outDir);
  const produced = join(outAbs, "mobile.html");
  if (existsSync(produced)) {
    renameSync(produced, join(outAbs, "index.html"));
  }
  process.stdout.write(
    `[build-web-remote-mobile-page] done → ${outAbs}（relay /remote/v4 静态目录）\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`[build-web-remote-mobile-page] 构建失败：${String(error)}\n`);
  process.exit(1);
});
