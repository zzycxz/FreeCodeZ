import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const SUPPORTED_DESKTOP_PLATFORM_KEYS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
];

/**
 * koffi 注入裁剪：afterPack 的运行时模块注入按包整目录复制，files 裁剪模式管不到这条
 * 路径——koffi 单包内置全平台预编译（2026-10-07 实测全平台集合约 41MB×asar/unpacked
 * 双份），注入后只保留目标平台目录（与 createDesktopNativePackagePrunePatterns 的
 * koffi 模式同一条规则的两个执行点）。
 */
export function pruneKoffiToTargetPlatform(moduleDir, targetPlatformKey) {
  assertSupportedTargetPlatformKey(targetPlatformKey);
  const platformsRoot = join(moduleDir, "build", "koffi");
  if (!existsSync(platformsRoot)) return 0;
  const keep = targetPlatformKey.replace("-", "_");
  let removed = 0;
  for (const entry of readdirSync(platformsRoot)) {
    if (entry !== keep) {
      rmSync(resolve(platformsRoot, entry), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

function assertSupportedTargetPlatformKey(targetPlatformKey) {
  if (!SUPPORTED_DESKTOP_PLATFORM_KEYS.includes(targetPlatformKey)) {
    throw new Error(`不支持的桌面目标平台: ${targetPlatformKey}`);
  }
}

export function createDesktopNativePackagePrunePatterns(targetPlatformKey) {
  assertSupportedTargetPlatformKey(targetPlatformKey);

  return [
    // PDF 预览已经由 Vite 打进 renderer，pdfjs-dist 的 Canvas optional dependency
    // 只服务 Node 渲染；pnpm 跨平台安装的 8 套 Canvas native 不应带进桌面安装包。
    "!node_modules/@napi-rs/canvas/**",
    "!node_modules/@napi-rs/canvas-*/**",
    // Linux prebuild 会在 beforePack 复制进 node-pty；源平台包本身不属于桌面运行时。
    "!node_modules/@lydell/node-pty-*/**",
    // 桌面运行时统一使用目标 prebuild，禁止把安装机现场编译物或 ABI bin 缓存带进跨平台包。
    "!node_modules/node-pty/build/**",
    "!node_modules/node-pty/bin/**",
    ...SUPPORTED_DESKTOP_PLATFORM_KEYS.filter((key) => key !== targetPlatformKey).map(
      (key) => `!node_modules/node-pty/prebuilds/${key}/**`,
    ),
    // koffi 单包内置全平台预编译（build/koffi/<os>_<arch>/koffi.node，2026-10-07 实测全平台
    // 集合约 41MB 被同时打进 asar 与 asar.unpacked 双份）；桌面运行时只解析目标平台目录。
    ...SUPPORTED_DESKTOP_PLATFORM_KEYS.filter((key) => key !== targetPlatformKey).map(
      (key) => `!node_modules/koffi/build/koffi/${key.replace("-", "_")}/**`,
    ),
  ];
}

function normalizeAsarPath(path) {
  const normalized = path.trim().replaceAll("\\", "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function parseAsarListWithPackState(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(pack|unpack)\s*:\s*(.+)$/.exec(line);
      if (!match) {
        throw new Error(`无法解析 asar pack state: ${line}`);
      }
      return { packState: match[1], path: normalizeAsarPath(match[2]) };
    });
}

function isNativeRuntimeFile(path, targetPlatformKey) {
  if (/\.(?:node|dll|dylib|exe)$/i.test(path)) return true;
  return path === `/node_modules/node-pty/prebuilds/${targetPlatformKey}/spawn-helper`;
}

export function findDesktopNativePackageViolations(entries, targetPlatformKey) {
  assertSupportedTargetPlatformKey(targetPlatformKey);
  const violations = [];

  for (const entry of entries) {
    const { packState, path } = entry;

    if (
      path === "/node_modules/@napi-rs/canvas" ||
      path.startsWith("/node_modules/@napi-rs/canvas/") ||
      path.startsWith("/node_modules/@napi-rs/canvas-")
    ) {
      violations.push(`不应打包 renderer 无需的 Canvas native: ${path}`);
      continue;
    }

    if (path.startsWith("/node_modules/@lydell/node-pty-")) {
      violations.push(`不应打包仅用于准备 prebuild 的平台源包: ${path}`);
      continue;
    }

    if (
      path.startsWith("/node_modules/node-pty/build/") ||
      path.startsWith("/node_modules/node-pty/bin/")
    ) {
      violations.push(`不应打包安装机生成的 node-pty 产物: ${path}`);
      continue;
    }

    const nodePtyPrebuildMatch = /^\/node_modules\/node-pty\/prebuilds\/([^/]+)/.exec(path);
    if (nodePtyPrebuildMatch && nodePtyPrebuildMatch[1] !== targetPlatformKey) {
      violations.push(`node-pty 包含非目标平台 prebuild: ${path}`);
      continue;
    }

    // koffi 的 build/koffi/<os>_<arch>/ 只允许目标平台目录（2026-10-07 实测全平台集合
    // 在 asar 与 asar.unpacked 双份携带约 73MB，其余平台对本机是死重）。
    const koffiPlatformMatch = /^\/node_modules\/koffi\/build\/koffi\/([^/]+)/.exec(path);
    if (
      koffiPlatformMatch &&
      koffiPlatformMatch[1] !== targetPlatformKey.replace("-", "_")
    ) {
      violations.push(`koffi 包含非目标平台二进制: ${path}`);
      continue;
    }

    // sharp/@img 不属于桌面 host 运行时（sharp 是 prepare 阶段的打包文件源，走 devDependencies；
    // node_repl 会话用的是 staged glm/packages 里的裁剪副本）——app.asar 里出现即打包回归。
    if (path === "/node_modules/sharp" || path.startsWith("/node_modules/sharp/")) {
      violations.push(`sharp 不应进入 app.asar（staged glm 才是它的归宿）: ${path}`);
      continue;
    }
    if (path === "/node_modules/@img" || path.startsWith("/node_modules/@img/")) {
      violations.push(`@img 不应进入 app.asar（staged glm 才是它的归宿）: ${path}`);
      continue;
    }

    if (isNativeRuntimeFile(path, targetPlatformKey) && packState !== "unpack") {
      violations.push(`native 文件仍作为 packed payload 留在 app.asar: ${path}`);
    }
  }

  return violations;
}
