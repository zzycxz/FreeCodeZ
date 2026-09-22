#!/usr/bin/env node
// 由官方市场冻结快照生成 shared 内嵌 manifest（packages/shared/src/bundled-plugin-marketplace.ts）。
// 策略见 docs/spec/marketplace-official-snapshot.md：目录零回连，但条目必须保留
// 完整 Store Listing 与 source（zip URL + sha256）——图标、描述、安装能力都依赖这些字段。
// 仅剔除 _artifact（CDN 内部元数据，运行时无消费者）。
// 更新快照后运行：node scripts/gen-bundled-marketplace.mjs
// 生成/校验逻辑导出供 packages/services/test/pluginMarketplaceParity.test.ts 做 C1 合同测试。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SNAPSHOT_PATH = join(repoRoot, "config/plugin-marketplace/official-snapshot.json");
export const OUTPUT_PATH = join(repoRoot, "packages/shared/src/bundled-plugin-marketplace.ts");

const DROP_ENTRY_KEYS = new Set(["_artifact"]);

// C1 快照字段合同（docs/spec/plugin-marketplace-parity.md §6）：核心字段缺失即生成失败，
// 防止再次产出「只剩 name」的空壳目录（P4 剥离事故的机械化防线）。
// displayName(+_i18n)/requiresPaidPlan/homepage 等是合法可选（解析侧有 name 回退），不设强制。
const REQUIRED_ENTRY_KEYS = [
  "name",
  "source",
  "description",
  "description_i18n",
  "version",
  "author",
  "icon",
  "category",
  "keywords",
];
const REQUIRED_SOURCE_KEYS = ["source", "type", "url", "sha256", "path"];

/** C1 合同校验：返回违规清单（空数组即通过）。 */
export function collectSnapshotContractErrors(snapshot) {
  const errors = [];
  for (const entry of snapshot?.plugins ?? []) {
    const label = typeof entry.name === "string" && entry.name ? entry.name : "<unnamed>";
    for (const key of REQUIRED_ENTRY_KEYS) {
      const value = entry[key];
      if (value === undefined || value === null || value === "") {
        errors.push(`${label}: missing entry field "${key}"`);
      }
    }
    if (entry.source && typeof entry.source === "object") {
      for (const key of REQUIRED_SOURCE_KEYS) {
        const value = entry.source[key];
        if (value === undefined || value === null || value === "") {
          errors.push(`${label}: missing source field "${key}"`);
        }
      }
    }
  }
  return errors;
}

/** 由快照渲染 shared 内嵌模块正文（与落盘产物逐字节一致）。 */
export function renderBundledMarketplaceModule(snapshot) {
  const plugins = snapshot.plugins.map((entry) => {
    const cleaned = {};
    for (const [key, value] of Object.entries(entry)) {
      if (!DROP_ENTRY_KEYS.has(key)) cleaned[key] = value;
    }
    return cleaned;
  });

  const manifest = {
    name: snapshot.name,
    description: snapshot.description,
    plugins,
  };

  return `/* eslint-disable max-lines -- 机器生成的冻结快照，行数由官方目录规模决定。 */
/* FreeCodeZ fork：官方市场目录冻结快照（随包内置，目录不回连 CDN；图标/zip 为
   下行 fetch，见 docs/spec/marketplace-official-snapshot.md）。
   由 config/plugin-marketplace/official-snapshot.json 经 scripts/gen-bundled-marketplace.mjs
   生成；更新快照后重新运行脚本生成本模块。禁止手改。 */
export const BUNDLED_OFFICIAL_PLUGIN_MARKETPLACE_MANIFEST = ${JSON.stringify(manifest, null, 2)} as const;
`;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  const contractErrors = collectSnapshotContractErrors(snapshot);
  if (contractErrors.length > 0) {
    console.error(
      `official-snapshot.json 字段合同校验失败（C1，见 docs/spec/plugin-marketplace-parity.md §6）：\n- ${contractErrors.join("\n- ")}`,
    );
    process.exit(1);
  }
  writeFileSync(OUTPUT_PATH, renderBundledMarketplaceModule(snapshot), "utf8");
  console.log(`generated ${OUTPUT_PATH}: ${snapshot.plugins.length} plugins`);
}
