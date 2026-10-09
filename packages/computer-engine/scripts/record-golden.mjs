#!/usr/bin/env node
// FreeCodeZ W-22 录制器：对新 sidecar 契约录制金样（期望值=新引擎自有点位，R4）。
// 用法：node scripts/record-golden.mjs [--only <id>]
// 产物：test/golden/samples/<id>.json（{scenario, method, params, response}）。
// 无 TCC 环境只落错误族/探测面成功样本；needsTcc 场景记 skipped 清单。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ComputerSidecarHarness } from "../src/host/sidecar-harness.ts";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const samplesDir = join(pkgRoot, "test", "golden", "samples");

const { GOLDEN_SCENARIOS, GOLDEN_SCENARIOS_EXTRA } = await import(
  join(pkgRoot, "test", "golden", "scenarios.ts")
);

execFileSync(process.execPath, [join(pkgRoot, "scripts", "build-sidecar.mjs")], {
  cwd: pkgRoot,
  stdio: "pipe",
});

const helperAppPath = join(
  pkgRoot,
  "native",
  "computer-use-macos",
  ".build",
  "release",
  "FreeCodeZ Computer Use.app",
);

const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : undefined;

mkdirSync(samplesDir, { recursive: true });
// W-11 红线（peer 信任）：helper 只认 app.freecodez.* 族进程——录制必须跑在应用身份下
// （Electron-as-node），裸 node 会被 helper 正确拒绝（trust 面 working as designed）。
const appExecutable = process.env.FREECODEZ_RECORD_APP_EXECUTABLE ?? [
  pkgRoot, "..", "desktop", "dist", "mac-arm64", "FreeCodeZ.app", "Contents", "MacOS", "FreeCodeZ",
].reduce((acc, part) => join(acc, part), "");
const { existsSync } = await import("node:fs");
const useAppIdentity = existsSync(appExecutable);
const harness = new ComputerSidecarHarness({
  sidecarPath: join(pkgRoot, "dist", "computer-sidecar.js"),
  env: {
    FREECODEZ_COMPUTER_MACOS_HELPER_APP_PATH: helperAppPath,
    ...(useAppIdentity ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  },
  ...(useAppIdentity ? { execPath: appExecutable } : {}),
});
if (!useAppIdentity) {
  console.log("[record-golden] WARN: app executable missing — recording under bare node (helper peer-trust will reject; error-form only)");
}

const skipped = [];
try {
  for (const scenario of [...GOLDEN_SCENARIOS, ...GOLDEN_SCENARIOS_EXTRA]) {
    if (only && scenario.id !== only) continue;
    const response = await harness.request(scenario.method, scenario.params);
    const isError = response.ok !== true;
    const needsTcc = scenario.needsTcc === true;
    const sample = {
      scenario: scenario.id,
      note: scenario.note,
      method: scenario.method,
      params: scenario.params ?? {},
      response,
      recordedAt: new Date().toISOString(),
      engine: "orca-1.4.214-snapshot",
    };
    if (needsTcc && !isError && response.ok === true && scenario.kind === "success") {
      // 成功面且需 TCC：本环境无授权时以错误形态落盘即为等价错误族样本。
    }
    writeFileSync(join(samplesDir, `${scenario.id}.json`), `${JSON.stringify(sample, null, 2)}\n`);
    console.log(`[record-golden] ${scenario.id}: ${isError ? "error" : "ok"}`);
    if (needsTcc && scenario.kind === "success" && isError) {
      skipped.push(scenario.id);
    }
  }
} finally {
  await harness.stop();
}
if (skipped.length > 0) {
  console.log(`[record-golden] TCC-pending scenarios recorded as error-form: ${skipped.join(", ")}`);
}
