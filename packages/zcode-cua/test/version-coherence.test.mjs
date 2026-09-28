// B1 门禁(spec F.4 轻量对账):四处版本相等 + runtime-manifest 哈希一致(R13)。
// vendored plugin package.json.version == .zcode-plugin/plugin.json.version ==
// official-plugin-definitions.ts 的 computer-use.version == runtime-manifest.packageVersion。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const vendoredRoot = join(repoRoot, "apps", "zcode-cli", "dependencies", "zcode-cua");

test("F.4 四处版本一致:plugin package.json/plugin.json/definitions/runtime-manifest", () => {
  const packageVersion = JSON.parse(
    readFileSync(join(vendoredRoot, "plugin", "package.json"), "utf8"),
  ).version;
  const manifestVersion = JSON.parse(
    readFileSync(join(vendoredRoot, "plugin", ".zcode-plugin", "plugin.json"), "utf8"),
  ).version;
  const definitionsSource = readFileSync(
    join(repoRoot, "apps", "zcode-cli", "packages", "bootstrap", "src", "app", "official-plugin-definitions.ts"),
    "utf8",
  );
  const definitionMatch = definitionsSource.match(/name: "computer-use"[\s\S]*?version: "([^"]+)"/);
  assert.ok(definitionMatch, "definitions 里找不到 computer-use 条目");
  const runtimeManifest = JSON.parse(
    readFileSync(join(vendoredRoot, "helper-runtime", "runtime-manifest.json"), "utf8"),
  );
  assert.equal(packageVersion, manifestVersion);
  assert.equal(packageVersion, definitionMatch[1]);
  assert.equal(packageVersion, runtimeManifest.packageVersion);
});

test("runtime-manifest 哈希与 electronVersion pin(R12/R13,fail-closed 面)", () => {
  const helperRoot = join(vendoredRoot, "helper-runtime");
  const manifest = JSON.parse(readFileSync(join(helperRoot, "runtime-manifest.json"), "utf8"));
  for (const key of ["entry", "addon"]) {
    const actual = createHash("sha256")
      .update(readFileSync(join(helperRoot, manifest[key])))
      .digest("hex");
    assert.equal(actual, manifest.sha256[key], `${key} 哈希失配`);
  }
  // electronVersion 唯一事实源是 electron-builder.config.js(生成器派生,禁止两处手写)。
  const configSource = readFileSync(
    join(repoRoot, "packages", "desktop", "electron-builder.config.js"),
    "utf8",
  );
  const pin = configSource.match(/electronVersion:\s*"([^"]+)"/)?.[1];
  assert.ok(pin, "electron-builder.config.js 缺 electronVersion");
  assert.equal(manifest.electronVersion, pin);
  assert.deepEqual(Object.keys(manifest).sort(), [
    "addon",
    "arch",
    "electronVersion",
    "entry",
    "packageName",
    "packageVersion",
    "platform",
    "schemaVersion",
    "sha256",
  ]);
});
