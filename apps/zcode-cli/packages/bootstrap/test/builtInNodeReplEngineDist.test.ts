// G1（2026-10-11 装机审计）回归：node_repl env 注入的引擎 dist 候选必须覆盖插件缓存布局。
// 插件 seed 后 hostPackage.rootPath 是缓存路径（…/cache/freecodez/node-repl-host/<ver>），
// 原候选「rootPath 旁的 computer-engine-dist」按 staging 布局算层级、缓存布局下永远
// 够不着 → env 不注入 → bridge 找不到 sidecar → CUA 断链。修复：resourcesPath 锚点首选。
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { computerEngineDistCandidates } from "../src/app/built-in-node-repl.js";

test("打包态（缓存 rootPath）：resourcesPath 锚点候选排最前", () => {
  const candidates = computerEngineDistCandidates({
    pluginRootPath: "/Users/x/.freecodez/cli/plugins/cache/freecodez/node-repl-host/0.6.0",
    workingDirectory: "/Users/x/Documents/test",
    resourcesPath: "/Applications/FreeCodeZ.app/Contents/Resources",
  });
  assert.equal(
    candidates[0],
    join("/Applications/FreeCodeZ.app/Contents/Resources", "glm", "packages", "computer-engine-dist"),
  );
});

test("打包 staging 布局：插件根旁 computer-engine-dist 候选在场", () => {
  const candidates = computerEngineDistCandidates({
    pluginRootPath: "/app/Resources/glm/packages/node-repl-host",
    workingDirectory: "/Users/x/Documents/test",
    resourcesPath: "/app/Resources",
  });
  assert.equal(candidates[1], resolve("/app/Resources/glm/packages/computer-engine-dist"));
});

test("开发态（无 resourcesPath）：workspace 引擎包与包根上溯候选在场", () => {
  const candidates = computerEngineDistCandidates({
    pluginRootPath: "/repo/apps/zcode-cli/packages/node-repl-host",
    workingDirectory: "/repo/packages/services",
  });
  assert.ok(
    candidates.includes(resolve("/repo/packages/computer-engine/dist")),
    `应含包根上溯候选: ${candidates.join(", ")}`,
  );
  assert.equal(candidates.length, 3, "无 resourcesPath 时不掺入打包候选");
});
