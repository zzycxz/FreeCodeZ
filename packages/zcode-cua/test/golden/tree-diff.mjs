// G2 逐字差分:官方 NRH 内联 formatAppStateTree vs 本实现,同一状态输入逐字比对。
// 官方 bundle esbuild 保留标识符——按锚点切出纯函数簇 eval,不反汇编。
// 用法:node packages/zcode-cua/test/golden/tree-diff.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatAppStateTree as ours } from "../../producer/tool-envelope.js";
import { asElements } from "../../producer/tool-observation.js";

const OFFICIAL_NRH =
  "C:/Users/13852/Downloads/zcode-3.14.3-unpacked/app/resources/glm/packages/node-repl-host/dist/mcp/server.js";
const bundle = readFileSync(OFFICIAL_NRH, "utf8");
const start = bundle.indexOf("function flag(");
const epStart = bundle.indexOf("function elementPriority(");
const end = bundle.indexOf("\nfunction ", epStart + 20);
if (start < 0 || epStart < 0 || end < 0) throw new Error("renderer anchors missing");
const slice = bundle.slice(start, end);
const factory = new Function(
  "process",
  `${slice}\nreturn { formatAppStateTree, elementRow, elementPriority };`,
);
const official = factory(process).formatAppStateTree;

// 金样 capture 结果 → 统一 state 形状(两侧渲染器输入同源)
const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "official-helper-win32.json"), "utf8"),
);
const golden = fixture.cases.find((c) => c.name === "capture_app_tree").response.result;

function stateFrom(raw, { elementCount } = {}) {
  const rawElements = elementCount ? raw.elements.slice(0, elementCount) : raw.elements;
  return {
    state_id: raw.state_id ?? "s-1",
    app: raw.app ?? {},
    window: raw.window ?? {},
    elements: asElements(rawElements ?? []),
    snapshot_mode: raw.snapshot_mode,
    screenshot_blank: raw.screenshot_blank,
  };
}

const scenes = {
  golden_full: stateFrom(golden),
  golden_tiny: stateFrom(golden, { elementCount: 2 }),
  empty_tree: stateFrom({ ...golden, elements: [] }),
  blank_screenshot: stateFrom({ ...golden, screenshot_blank: true }),
};

const report = { comparedAt: new Date().toISOString(), scenes: {} };
let clean = true;
for (const [name, state] of Object.entries(scenes)) {
  let a;
  let b;
  try {
    a = ours(state);
  } catch (error) {
    a = `THREW: ${error.message}`;
  }
  try {
    b = official(state);
  } catch (error) {
    b = `THREW: ${error.message}`;
  }
  const match = a === b;
  report.scenes[name] = { match, ours: a, official: b };
  if (!match) clean = false;
  console.log(`${match ? "MATCH" : "DIFF "} ${name}`);
}
writeFileSync(
  join(import.meta.dirname, "fixtures", "tree-render-diff.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
console.log(clean ? "G2 tree render: byte-identical" : "G2 tree render: DIFFERENCES (see fixtures/tree-render-diff.json)");
process.exit(clean ? 0 : 1);
