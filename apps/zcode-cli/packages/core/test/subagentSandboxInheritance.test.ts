// 0-3 修复测试（升级实施手册）：子代理必须结构性继承会话级沙箱开关（E-S3 sandboxEnabled）。
// 背景：subagent.ts 的 child runtime 配置是逐字段构造（与 workflow actor 的 ...inheritedConfig
// 展开不同），漏一个字段就是"父开沙箱、子代理裸奔"的后门。此测试是结构性锚——钉住继承关系
// 本身，防止后续改动把该字段顺手删掉；下游链路（runtime-tools → executor → bash handler）
// 已由 E-S3 既有回归锚覆盖。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

test("subagent 子运行时配置结构性继承 sandboxEnabled", () => {
  const source = readFileSync(
    join(here, "../src/runtime/methods/subagent.ts"),
    "utf8",
  );
  assert.match(
    source,
    /sandboxEnabled:\s*this\.config\.sandboxEnabled/,
    "subagent child 配置必须透传 this.config.sandboxEnabled（0-3 回归锚）",
  );
});

test("workflow actor 走 inheritedConfig 展开继承（不得改为显式白名单构造）", () => {
  const source = readFileSync(
    join(
      here,
      "../../../packages/bootstrap/src/app/script-workflow-child-runtime.ts",
    ),
    "utf8",
  );
  assert.match(
    source,
    /\.\.\.inheritedConfig/,
    "workflow actor 依赖展开继承携带全部会话级开关（含 sandboxEnabled），改为白名单构造会重演 0-3",
  );
});
