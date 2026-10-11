// G1（2026-10-11 装机审计）回归：sidecar 候选必须覆盖插件缓存布局。
// 装机后 node_repl server 从 ~/.freecodez/cli/plugins/cache/freecodez/node-repl-host/<ver>/
// dist/mcp/server.js 运行，原先的相对候选全按 staging/仓库布局算层级、在缓存布局下
// 永远够不着——导致 setupComputerUseRuntime 显式报 "sidecar is not built"（CUA 断链）。
// 修复：打包态锚定 process.resourcesPath（Helper-as-node 下指向 app Resources）。
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { sidecarCandidatePaths } from "../src/computer-bridge.js";

test("打包态（缓存布局）：resourcesPath 锚点候选排最前", () => {
  const candidates = sidecarCandidatePaths({
    here: "/Users/x/.freecodez/cli/plugins/cache/freecodez/node-repl-host/0.6.0/dist/mcp",
    resourcesPath: "/Applications/FreeCodeZ.app/Contents/Resources",
  });
  assert.equal(
    candidates[0],
    join(
      "/Applications/FreeCodeZ.app/Contents/Resources",
      "glm",
      "packages",
      "computer-engine-dist",
      "computer-sidecar.js",
    ),
  );
});

test("打包 staging 布局：包旁 computer-engine-dist 候选在场（次优先）", () => {
  const candidates = sidecarCandidatePaths({
    here: "/app/Resources/glm/packages/node-repl-host/dist/mcp",
    resourcesPath: "/app/Resources",
  });
  assert.equal(
    candidates[1],
    resolve("/app/Resources/glm/packages/node-repl-host/computer-engine-dist/computer-sidecar.js"),
  );
});

test("开发态源码布局（无 resourcesPath）：仓库引擎包 dist 候选在场", () => {
  const candidates = sidecarCandidatePaths({
    here: "/repo/apps/zcode-cli/packages/node-repl-host/src",
  });
  assert.ok(
    candidates.includes(resolve("/repo/packages/computer-engine/dist/computer-sidecar.js")),
    `dev src 候选应含仓库引擎 dist: ${candidates.join(", ")}`,
  );
  assert.equal(candidates.length, 3, "无 resourcesPath 时不掺入打包候选");
});

test("dev 构建产物布局（dist/mcp）：候选不抛错且数量一致", () => {
  const candidates = sidecarCandidatePaths({
    here: "/repo/apps/zcode-cli/packages/node-repl-host/dist/mcp",
  });
  assert.equal(candidates.length, 3);
});
