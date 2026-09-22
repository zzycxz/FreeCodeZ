// FreeCodeZ fork(plugin-marketplace-parity):官方目录 parity 的机械一致性与启动自愈单测。
// 运行:node --test packages/services/test/pluginMarketplaceParity.test.ts(经 tsx 加载源码)。
// 合同见 docs/spec/plugin-marketplace-parity.md §6(C1/C2/C3/C4/C5)与 §7(A2/A8)。
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../../..", import.meta.url);
const genScriptUrl = new URL("scripts/gen-bundled-marketplace.mjs", repoRoot);
const stagingListUrl = new URL("scripts/official-plugin-staging-list.mjs", repoRoot);
const definitionsUrl = new URL(
  "apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts",
  repoRoot,
);
const officialMarketplaceUrl = new URL(
  "apps/zcode-cli/packages/adapters/src/plugins/official-marketplace.ts",
  repoRoot,
);
const marketplaceUrl = new URL(
  "apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts",
  repoRoot,
);
const bundledManifestUrl = new URL("packages/shared/src/bundled-plugin-marketplace.ts", repoRoot);
const snapshotUrl = new URL("config/plugin-marketplace/official-snapshot.json", repoRoot);

// spec §10 决策:computer-use(zcode-cua-plugin)runtime 依赖 koffi/sharp 原生包,
// node_modules 不进 stage 白名单,暂不 vendor;就绪后从本名单移除即恢复 C3 全量对照。
const DEFERRED_DEFINITIONS = new Set(["computer-use"]);

const OFFICIAL_MARKETPLACE = "zcode-plugins-official";

test("C1 快照字段合同:26 条全过、产物同步,剥离 icon/source 的旧代样例被拒", async () => {
  const { collectSnapshotContractErrors, renderBundledMarketplaceModule, OUTPUT_PATH } =
    await import(genScriptUrl.href);
  const snapshot = JSON.parse(readFileSync(snapshotUrl, "utf8"));
  assert.ok(snapshot.plugins.length > 0);
  assert.deepEqual(collectSnapshotContractErrors(snapshot), []);

  // 生成产物与快照逐字节同步:防手改生成文件或漏跑生成脚本。
  assert.equal(
    renderBundledMarketplaceModule(snapshot),
    readFileSync(OUTPUT_PATH as unknown as string, "utf8"),
  );

  // C5 负例一:缺 icon(P4 剥离形态)必须被拒。
  const noIcon = structuredClone(snapshot.plugins[0]);
  delete noIcon.icon;
  assert.ok(
    collectSnapshotContractErrors({ plugins: [noIcon] }).some((error) => error.includes('"icon"')),
  );

  // C5 负例二:缺 source(不可安装形态)必须被拒。
  const noSource = structuredClone(snapshot.plugins[0]);
  delete noSource.source;
  assert.ok(
    collectSnapshotContractErrors({ plugins: [noSource] }).some((error) =>
      error.includes('"source"'),
    ),
  );

  // 负例三:source 缺 sha256(安装校验不可用)必须被拒。
  const noSha = structuredClone(snapshot.plugins[0]);
  delete noSha.source.sha256;
  assert.ok(
    collectSnapshotContractErrors({ plugins: [noSha] }).some((error) => error.includes('"sha256"')),
  );
});

test("C4/C5 旧代空壳缓存整体重播、known source 归一,且二次执行幂等", async () => {
  const { BUNDLED_OFFICIAL_PLUGIN_MARKETPLACE_MANIFEST } = await import(bundledManifestUrl.href);
  const { ensureDefaultPluginMarketplaces, loadMarketplaceManifestSync } = await import(
    marketplaceUrl.href
  );

  const storageRoot = mkdtempSync(join(tmpdir(), "zcode-parity-"));
  try {
    // P4~P7 旧代产物:CDN 分片只剩 name、known source 为占位 stub(实机形态的最小复刻)。
    const partitionDir = join(storageRoot, "marketplaces", OFFICIAL_MARKETPLACE);
    mkdirSync(partitionDir, { recursive: true });
    const cdnPath = join(partitionDir, "cdn-marketplace.json");
    const knownPath = join(storageRoot, "known_marketplaces.json");
    const mergedPath = join(partitionDir, "marketplace.json");
    writeFileSync(
      cdnPath,
      JSON.stringify({
        name: OFFICIAL_MARKETPLACE,
        description: "FreeCodeZ bundled snapshot of the official plugin marketplace (frozen).",
        plugins: [{ name: "mimosa" }, { name: "github" }],
      }),
    );
    writeFileSync(
      knownPath,
      JSON.stringify({
        version: 1,
        marketplaces: [
          {
            id: OFFICIAL_MARKETPLACE,
            source: {
              source: "settings",
              marketplace: {
                name: OFFICIAL_MARKETPLACE,
                plugins: [{ name: "mimosa" }],
              },
            },
            name: OFFICIAL_MARKETPLACE,
            addedAt: "2026-09-22T00:00:00.000Z",
            pluginCount: 1,
          },
        ],
      }),
    );

    const records = ensureDefaultPluginMarketplaces(storageRoot);
    const official = records.find((record) => record.id === OFFICIAL_MARKETPLACE);
    assert.ok(official);

    // C5:旧代空壳整体重播——条目必须带回安装 source 与展示 icon。
    const cdn = JSON.parse(readFileSync(cdnPath, "utf8"));
    assert.ok(cdn.plugins.length >= 26, `期望快照条目数,实际 ${cdn.plugins.length}`);
    for (const entry of cdn.plugins) {
      assert.ok(entry.source, `${entry.name} 缺 source`);
      assert.ok(entry.icon, `${entry.name} 缺 icon`);
    }

    // 商店投影:listing.icon 是卡片图标的唯一来源(spec §5 运行期链路)。
    const merged = loadMarketplaceManifestSync(storageRoot, OFFICIAL_MARKETPLACE);
    const mimosa = merged?.plugins.find((plugin) => plugin.name === "mimosa");
    assert.ok(mimosa?.listing?.icon?.startsWith("https://"), "listing.icon 应为 https 图标地址");
    assert.ok(mimosa?.listing?.displayName, "listing.displayName 应随快照下发");

    // A2:known source 归一到内嵌快照形态(deep-equal),旧占位 stub 不复存在。
    assert.deepEqual(official.source, {
      source: "settings",
      marketplace: BUNDLED_OFFICIAL_PLUGIN_MARKETPLACE_MANIFEST,
    });

    // C4 幂等:再次执行后三个文件字节不变(健康态零写盘)。
    const before = [cdnPath, knownPath, mergedPath].map((path) => readFileSync(path, "utf8"));
    ensureDefaultPluginMarketplaces(storageRoot);
    const after = [cdnPath, knownPath, mergedPath].map((path) => readFileSync(path, "utf8"));
    assert.deepEqual(after, before);
  } finally {
    rmSync(storageRoot, { force: true, recursive: true });
  }
});

test("C2/C3 stage 清单 ↔ definitions ↔ 包体机械一致", async () => {
  const { officialPluginStagingList, assertOfficialPluginSourcesExist } = await import(
    stagingListUrl.href
  );
  const { OFFICIAL_PLUGIN_DEFINITIONS } = await import(definitionsUrl.href);
  const repoRootPath = fileURLToPath(repoRoot);

  // A7:清单指向的包体与 manifest 必须在场(删包即挂)。
  assertOfficialPluginSourcesExist(repoRootPath);

  const stagingByStagedPath = new Map(
    officialPluginStagingList.map((entry) => [entry.stagedPath, entry]),
  );
  for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
    if (DEFERRED_DEFINITIONS.has(definition.name)) continue;
    const stagedPath = definition.rootCandidates[0];
    const entry = stagingByStagedPath.get(stagedPath);
    assert.ok(entry, `definition ${definition.name} 缺 stage 条目(${stagedPath})`);
    stagingByStagedPath.delete(stagedPath);

    // C2:三处版本一致(definition ↔ 包内 manifest),防「升版漏改」分叉。
    const manifestPath = join(
      repoRootPath,
      (entry as { relativePath: string }).relativePath,
      ".zcode-plugin",
      "plugin.json",
    );
    assert.ok(existsSync(manifestPath), `${definition.name} 缺 manifest`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.name, definition.name);
    assert.equal(manifest.version, definition.version, `${definition.name} 版本不一致`);

    for (const requiredPath of definition.requiredSeedPaths ?? []) {
      assert.ok(
        existsSync(
          join(
            repoRootPath,
            (entry as { relativePath: string }).relativePath,
            ...requiredPath.split("/"),
          ),
        ),
        `${definition.name} 缺必需种子文件 ${requiredPath}`,
      );
    }
  }
  assert.deepEqual([...stagingByStagedPath.keys()], [], "stage 清单存在无 definition 对应的条目");
});
