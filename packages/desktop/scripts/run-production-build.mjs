import { readdir, rm } from "node:fs/promises";
import process from "node:process";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSpawnRuntimeOptions } from "../../../scripts/spawn-command.mjs";

export function resolveDesktopBuildCwd() {
  // tsup / vite 配置里的入口路径都是相对 desktop 包根目录声明的。
  // 之前默认 cwd 落在 scripts 子目录，Windows CI 上会把 src/main/index.ts 解析成 scripts/src/... 直接报找不到入口。
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function resolveDesktopProductionCleanPaths(cwd) {
  return [
    resolve(cwd, "out/main"),
    resolve(cwd, "out/host"),
    resolve(cwd, "out/preload"),
    resolve(cwd, "out/renderer"),
    // scheduler 是独立 tsup target:漏清理时旧 hash chunk 会与新 chunk 并存,被 out/**/*
    // 一并打进 app.asar(2026-09-24 A16 实测:占位时代 chunk 藏在其中,标记扫描不过)。
    resolve(cwd, "out/scheduler"),
    resolve(cwd, "out/.main-build-ready"),
    resolve(cwd, "out/.host-build-ready"),
    resolve(cwd, "out/.preload-build-ready"),
    resolve(cwd, "out/.scheduler-build-ready"),
    // 手机页 bundle 同理:旧 hash 资产并存会被 extraResources 全量拷进 resources/web-remote-mobile。
    resolve(cwd, "..", "..", "packages", "web", "dist-mobile"),
  ];
}

export async function cleanDesktopProductionOutput({ cwd }) {
  if ((process.env.FREECODEZ_E2E_KEEP_BUILD_CACHE ?? process.env.ZCODE_E2E_KEEP_BUILD_CACHE) === "1") {
    console.log("[build] ZCODE_E2E_KEEP_BUILD_CACHE=1, skipping clean");
    return;
  }
  // 生产构建之前如果已有开发态/旧生产态 out，tsup 不会主动删除过期 chunk。
  // 这些旧文件会继续被 electron-builder 的 out/**/* 打进 app.asar，重新暴露未压缩 JS 和 sourcemap 尾注。
  await Promise.all(
    resolveDesktopProductionCleanPaths(cwd).map((targetPath) =>
      rm(targetPath, { force: true, recursive: true }),
    ),
  );
  // out/ 根层散落的 *.node（esbuild copy-loader 哈希产物）不在任何子目录清单里，
  // 2026-10-13 实测 18 份 koffi 全平台二进制化石（33MB）自 10-03 起随每包分发；
  // 目录级 rm 管不到单文件，这里单独清 out 根的原生模块散件防复发。
  const outRootEntries = await readdir(resolve(cwd, "out"), { withFileTypes: true }).catch(() => []);
  await Promise.all(
    outRootEntries
      .filter((entry) => entry.isFile() && /\.node$/i.test(entry.name))
      .map((entry) => rm(resolve(cwd, "out", entry.name), { force: true })),
  );
}

export function createDesktopProductionBuildPlan({ cwd, baseEnv = process.env }) {
  const env = {
    ...baseEnv,
    NODE_ENV: "production",
  };

  return [
    {
      label: "desktop production bundles",
      parallel: [
        {
          command: "pnpm",
          args: ["exec", "tsup"],
          cwd,
          env,
        },
        {
          command: "pnpm",
          args: ["exec", "vite", "build"],
          cwd,
          env,
        },
        {
          // 移动端远控手机页 bundle（dist-mobile）：内嵌 LAN relay 的 /remote/v4 静态源，
          // 由 electron-builder extraResources 随包分发。脚本在仓库根，自含 vite 配置。
          command: "node",
          args: ["scripts/build-web-remote-mobile-page.mjs"],
          cwd: resolve(cwd, "..", ".."),
          env,
        },
      ],
    },
  ];
}

function runCommandAsync(step) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(step.command, step.args, {
      cwd: step.cwd,
      env: step.env,
      stdio: "inherit",
      ...resolveSpawnRuntimeOptions(step.command),
    });

    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }

      const reason = signal ? `signal ${signal}` : `code ${code}`;
      rejectRun(new Error(`${step.command} ${step.args.join(" ")} failed with ${reason}`));
    });
  });
}

export async function runDesktopProductionBuild({ cwd = resolveDesktopBuildCwd() } = {}) {
  await cleanDesktopProductionOutput({ cwd });
  for (const step of createDesktopProductionBuildPlan({ cwd })) {
    if (step.parallel) {
      // 之前串行跑 tsup 和 vite，但两者分别写 main/preload/host 与 renderer 目录。
      // 这里并行执行平台无关构建，缩短 CI 关键路径，同时保持各自 cwd/env 一致以兼容 macOS/Windows/Linux runner。
      await Promise.all(step.parallel.map(runCommandAsync));
      continue;
    }

    await runCommandAsync(step);
  }
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  await runDesktopProductionBuild();
}
