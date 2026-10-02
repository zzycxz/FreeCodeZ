// B2 输出卫生单测：spawn env 必须注入无色化/分页禁用变量（NO_COLOR/TERM=dumb/
// PAGER 族），并摘除 FORCE_COLOR/CLICOLOR_FORCE 强制开色变量；ZCODE_PRESERVE_COLOR=1
// 逃生口开启时行为与现状逐字一致。Windows 侧要求大小写不敏感去重后单值写入。
import assert from "node:assert/strict";
import test from "node:test";
import { buildExecutionEnv } from "../src/exec/execution-command.js";

const HYGIENE_EXPECTED = {
  NO_COLOR: "1",
  TERM: "dumb",
  COLORTERM: "",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GH_PAGER: "cat",
};

test("默认注入全套无色化变量并摘除强制开色变量", () => {
  const env = buildExecutionEnv(undefined, {
    platform: "darwin",
    processEnv: { PATH: "/usr/bin", FORCE_COLOR: "1", CLICOLOR_FORCE: "1" },
  });
  for (const [key, value] of Object.entries(HYGIENE_EXPECTED)) {
    assert.equal(env[key], value, `${key} 应为 ${value}`);
  }
  assert.equal(env.FORCE_COLOR, undefined);
  assert.equal(env.CLICOLOR_FORCE, undefined);
});

test("逃生口 ZCODE_PRESERVE_COLOR=1 时不注入（行为与现状一致）", () => {
  const env = buildExecutionEnv(undefined, {
    platform: "darwin",
    processEnv: { PATH: "/usr/bin", ZCODE_PRESERVE_COLOR: "1", TERM: "xterm-256color" },
  });
  assert.equal(env.NO_COLOR, undefined);
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.GIT_PAGER, undefined);
});

test("工具显式 env overlay 优先于卫生注入（按命令指定仍可开色）", () => {
  const env = buildExecutionEnv(
    { base: "inherit", set: { CLICOLOR_FORCE: "1" } },
    { platform: "darwin", processEnv: { PATH: "/usr/bin" } },
  );
  assert.equal(env.CLICOLOR_FORCE, "1");
  assert.equal(env.NO_COLOR, "1");
});

test("base=empty 的封闭 env 同样注入卫生变量", () => {
  const env = buildExecutionEnv({ base: "empty" }, {
    platform: "darwin",
    processEnv: { PATH: "/usr/bin" },
  });
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.PAGER, "cat");
});

test("Windows 大小写不敏感：旧 CLICOLOR_FORCE 变体被清除且不留重复键", () => {
  const env = buildExecutionEnv(undefined, {
    platform: "win32",
    processEnv: { PATH: "C:\\", force_color: "1", ClColor_Force: "1" },
  });
  const keys = Object.keys(env).filter(
    (key) => key.toLowerCase() === "force_color" || key.toLowerCase() === "clicolor_force",
  );
  assert.deepEqual(keys, []);
  assert.equal(env.NO_COLOR, "1");
});
