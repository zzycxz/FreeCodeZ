/**
 * P4b：readToolResultCuaApp 形状校验单测。
 * 身份字段宁缺勿错——错值会让 UI 把无关 js 行误分进电脑操作卡组。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readToolResultCuaApp } from "../src/tool/executor/call-runner.js";

const META = "freecodez/nodeReplCuaApp";

test("合法身份：pid/名称/bundleId 全带与不带 bundleId 两种形态", () => {
  assert.deepEqual(
    readToolResultCuaApp({
      responseMeta: { [META]: { pid: 4242, name: "TextEdit", bundleId: "com.apple.TextEdit" } },
    }),
    { pid: 4242, name: "TextEdit", bundleId: "com.apple.TextEdit" },
  );
  assert.deepEqual(
    readToolResultCuaApp({ responseMeta: { [META]: { pid: 1, name: "  App  " } } }),
    { pid: 1, name: "App" },
  );
});

test("缺 meta / 缺 app / 非 object 一律 undefined", () => {
  assert.equal(readToolResultCuaApp(undefined), undefined);
  assert.equal(readToolResultCuaApp(null), undefined);
  assert.equal(readToolResultCuaApp({}), undefined);
  assert.equal(readToolResultCuaApp({ responseMeta: null }), undefined);
  assert.equal(readToolResultCuaApp({ responseMeta: {} }), undefined);
  assert.equal(readToolResultCuaApp({ responseMeta: { [META]: "not-object" } }), undefined);
});

test("非法形状丢弃：pid 非正整数/名称空或超长/bundleId 非串或超长", () => {
  assert.equal(
    readToolResultCuaApp({ responseMeta: { [META]: { pid: 0, name: "X" } } }),
    undefined,
  );
  assert.equal(
    readToolResultCuaApp({ responseMeta: { [META]: { pid: 1.5, name: "X" } } }),
    undefined,
  );
  assert.equal(
    readToolResultCuaApp({ responseMeta: { [META]: { pid: 1, name: "   " } } }),
    undefined,
  );
  assert.equal(
    readToolResultCuaApp({ responseMeta: { [META]: { pid: 1, name: "x".repeat(257) } } }),
    undefined,
  );
  assert.equal(
    readToolResultCuaApp({ responseMeta: { [META]: { pid: 1, name: "X", bundleId: 42 } } }),
    undefined,
  );
  assert.equal(
    readToolResultCuaApp({
      responseMeta: { [META]: { pid: 1, name: "X", bundleId: "b".repeat(513) } },
    }),
    undefined,
  );
});

test("meta 里其他键（zcode/toolSurface 等）不受影响、不误读", () => {
  assert.equal(
    readToolResultCuaApp({ responseMeta: { "zcode/toolSurface": { openTabIds: [1] } } }),
    undefined,
  );
});
