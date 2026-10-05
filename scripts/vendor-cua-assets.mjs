#!/usr/bin/env node
/* eslint-disable max-lines -- vendoring 流水线集中保留,便于升级 SOP(F.2)单文件执行。 */

// CUA 资产 vendoring 唯一入口(docs/spec/computer-control-capability.md §8 B1-1/W-07):
// 官方 3.14.3 解包资产 -> apps/zcode-cli/dependencies/zcode-cua/{plugin,helper-runtime},
// 同批完成后处理(禁手改 vendored 文件,改则 runtime-manifest SHA-256 失配 fail-closed):
//   1) W-07 品牌清扫(FreeCodeZ 目标):严格按 master spec V2.1 附录 H.3-2 映射表——
//      plugin 侧仅映射表点名文案;helper 侧错误/日志文案同句式替换;
//   2) 冻结面(H.3-2 末行)绝不替换:ZCodeComputerUseIPC-1、dev.zcode.* 身份锚点、
//      ZCODE_CUA_* env 族、管道前缀、Symbol、zcode.cua/* meta keys——违者断链/自拒;
//   3) D1 悬空码按 V2.1 D1-③ 保真照搬(SKILL 原文不改;收敛属增补 J-4,未拍板不启动);
//   4) runtime-manifest.json 重生成(sha256 重算 + electronVersion 从 electron-builder.config.js 派生);
//   5) SHA256SUMS 记账(沿 dependencies/native-search 先例)。
//
// 用法:node scripts/vendor-cua-assets.mjs [--source <解包 app/resources 目录>]
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const DEFAULT_SOURCE = "C:/Users/13852/Downloads/zcode-3.14.3-unpacked/app/resources";

function parseArgs(argv) {
  const args = { source: (process.env.FREECODEZ_CUA_ASSET_SOURCE ?? process.env.ZCODE_CUA_ASSET_SOURCE)?.trim() || DEFAULT_SOURCE };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--source" && argv[i + 1]) {
      args.source = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

// ── H.3-2 品牌映射(仅 FreeCodeZ 目标;精确字面量,注释与未点名文本不动) ─────────────────

// plugin 侧精确映射(master spec V2.1 H.3-2 表):SKILL/docs 的 session 短语 + SDK:892 错误文案。
const PLUGIN_BRAND_REPLACEMENTS = [
  ["ZCode Computer Use session", "FreeCodeZ Computer Use session"],
  [
    "Use Computer Use from a ZCode desktop or shared-host session.",
    "Use Computer Use from a FreeCodeZ desktop or shared-host session.",
  ],
];

// helper 侧文案面(H.3-2 行 3:含 ZCode 字样的错误/日志文案同句式替换)。
// 冻结契约串先摘出后放回:H.3-2 末行禁止替换,违者协议自拒。
const PROTECTED_LITERALS = [["ZCodeComputerUseIPC-1", " ZCIPC "]];

function helperBrandReplace(text) {
  let out = text;
  for (const [literal, token] of PROTECTED_LITERALS) out = out.split(literal).join(token);
  out = out.replaceAll(/\bZCode\b/gu, "FreeCodeZ");
  for (const [literal, token] of PROTECTED_LITERALS) out = out.split(token).join(literal);
  return out;
}

function pluginBrandReplace(text) {
  let out = text;
  for (const [from, to] of PLUGIN_BRAND_REPLACEMENTS) out = out.split(from).join(to);
  return out;
}

// ── 工具 ────────────────────────────────────────────────────────────────────────────

function walkFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeSha256Sums(root) {
  const files = walkFiles(root)
    .map((file) => relative(root, file).replaceAll("\\", "/"))
    .filter((rel) => rel !== "SHA256SUMS")
    .sort();
  const lines = files.map((rel) => `${sha256File(join(root, rel))}  ${rel}`);
  writeFileSync(join(root, "SHA256SUMS"), `${lines.join("\n")}\n`, "utf8");
  return files.length;
}

function readElectronVersionPin() {
  const configPath = join(repoRoot, "packages/desktop/electron-builder.config.js");
  const source = readFileSync(configPath, "utf8");
  const match = source.match(/electronVersion:\s*"([^"]+)"/);
  if (!match?.[1]) {
    throw new Error(`[vendor-cua] cannot derive electronVersion pin from ${configPath}`);
  }
  return match[1];
}

function processTextFiles(root, transform, { extensions }) {
  let touched = 0;
  for (const file of walkFiles(root)) {
    if (!extensions.some((ext) => file.endsWith(ext))) continue;
    const before = readFileSync(file, "utf8");
    const after = transform(before, file);
    if (after !== before) {
      writeFileSync(file, after, "utf8");
      touched += 1;
    }
  }
  return touched;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────────────

function vendorPlugin(sourceRoot, targetRoot) {
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });
  cpSync(sourceRoot, targetRoot, { recursive: true });

  // S2 裁剪 (a):package.json 裁掉 scripts/dependencies/devDependencies 并保持 private。
  const packageJsonPath = join(targetRoot, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  delete packageJson.scripts;
  delete packageJson.dependencies;
  delete packageJson.devDependencies;
  packageJson.private = true;
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

  // H.3-2 表行:plugin.json author。
  const pluginJsonPath = join(targetRoot, ".zcode-plugin", "plugin.json");
  const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
  if (pluginJson.author?.name === "Z.ai") pluginJson.author.name = "FreeCodeZ";
  writeFileSync(pluginJsonPath, `${JSON.stringify(pluginJson, null, 2)}\n`, "utf8");

  // 品牌映射(精确字面量;注释不动)。D1 悬空码保真照搬(D1-③),不做收敛。
  return processTextFiles(targetRoot, (text) => pluginBrandReplace(text), {
    extensions: [".md", ".mjs"],
  });
}

function vendorHelperRuntime(sourceRoot, targetRoot) {
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });
  cpSync(sourceRoot, targetRoot, { recursive: true });

  // helper 文案面品牌替换(冻结串保护)。dev.zcode.* 身份锚点保持 verbatim(H.3-2 禁止替换)。
  const touched = processTextFiles(targetRoot, (text) => helperBrandReplace(text), {
    extensions: [".js", ".md"],
  });

  const pluginPackageJson = JSON.parse(
    readFileSync(join(targetRoot, "..", "plugin", "package.json"), "utf8"),
  );
  const manifest = {
    schemaVersion: 1,
    packageName: "@zcode/zcode-cua",
    packageVersion: pluginPackageJson.version,
    platform: "win32",
    arch: "x64",
    electronVersion: readElectronVersionPin(),
    entry: "dist/windows-helper.js",
    addon: "build/Release/ax_native.node",
    sha256: {
      entry: sha256File(join(targetRoot, "dist", "windows-helper.js")),
      addon: sha256File(join(targetRoot, "build", "Release", "ax_native.node")),
    },
  };
  writeFileSync(
    join(targetRoot, "runtime-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return { touched, manifest };
}

function verify(targetPlugin, targetHelper, manifest) {
  const problems = [];
  // helper 文案面:除冻结契约串外零 ZCode;且 dev.zcode.* 锚点必须仍在(H.3-2 禁止替换断言)。
  for (const file of walkFiles(targetHelper)) {
    if (!file.endsWith(".js") && !file.endsWith(".md")) continue;
    const text = readFileSync(file, "utf8");
    const stripped = text.split("ZCodeComputerUseIPC-1").join("");
    if (/\bZCode\b/u.test(stripped)) problems.push(`brand residue: ${relative(targetHelper, file)}`);
  }
  const helperEntry = readFileSync(join(targetHelper, "dist", "windows-helper.js"), "utf8");
  for (const anchor of ["dev.zcode.cua-helper", "dev.zcode.app"]) {
    if (!helperEntry.includes(anchor)) {
      problems.push(`frozen anchor missing (must NOT be renamed): ${anchor}`);
    }
  }
  if (!helperEntry.includes("ZCodeComputerUseIPC-1")) {
    problems.push("frozen contract string missing: ZCodeComputerUseIPC-1");
  }
  // plugin 侧:H.3-2 映射项必须已替换;注释内 ZCode 属 P10 不动桶,允许保留。
  for (const file of walkFiles(targetPlugin)) {
    if (!file.endsWith(".md") && !file.endsWith(".mjs")) continue;
    const text = readFileSync(file, "utf8");
    for (const [from] of PLUGIN_BRAND_REPLACEMENTS) {
      if (text.includes(from)) problems.push(`brand mapping not applied: ${relative(targetPlugin, file)}`);
    }
  }
  // manifest 哈希一致性(R13)。
  for (const key of ["entry", "addon"]) {
    const actual = sha256File(join(targetHelper, manifest[key]));
    if (actual !== manifest.sha256[key]) problems.push(`manifest sha256 mismatch: ${key}`);
  }
  return problems;
}

const { source } = parseArgs(process.argv);
const sourceHelper = join(source, "tools", "cua-helper");
const sourcePlugin = join(source, "glm", "packages", "zcode-cua-plugin");
for (const dir of [sourceHelper, sourcePlugin]) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`[vendor-cua] asset source missing: ${dir} (use --source)`);
  }
}

const targetRoot = join(repoRoot, "apps", "zcode-cli", "dependencies", "zcode-cua");
const targetPlugin = join(targetRoot, "plugin");
const targetHelper = join(targetRoot, "helper-runtime");

console.log(`[vendor-cua] source: ${source}`);
const pluginBranded = vendorPlugin(sourcePlugin, targetPlugin);
const { touched: helperTouched, manifest } = vendorHelperRuntime(sourceHelper, targetHelper);
const pluginFiles = writeSha256Sums(targetPlugin);
const helperFiles = writeSha256Sums(targetHelper);

const problems = verify(targetPlugin, targetHelper, manifest);
if (problems.length > 0) {
  console.error("[vendor-cua] verification failed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`[vendor-cua] plugin: ${pluginFiles} files, ${pluginBranded} branded`);
console.log(`[vendor-cua] helper-runtime: ${helperFiles} files, ${helperTouched} processed`);
console.log(`[vendor-cua] manifest electronVersion pin: ${manifest.electronVersion}`);
console.log("[vendor-cua] OK (D1-③ 保真;H.3-2 冻结面已断言)");
