// FreeCodeZ fork(Bots):命令文法全别名表 + "0"/数字语义（附录B §1.1-§1.3）。
// 运行: node --test packages/services/test/botsCommands.test.ts（经 tsx 加载源码）。
import assert from "node:assert/strict";
import test from "node:test";
import { parseBotCommand, splitCommand } from "@zcode/shared/bots";
import {
  isSelectionIndexValue,
  resolveSelectionOptionId,
} from "../src/bots/inboundPipeline.js";

// 附录B §1.2 完整别名表（case-insensitive）
const simpleAliases: Array<[string[], string]> = [
  [["help", "帮助"], "help"],
  [["status", "状态"], "status"],
  [["new", "clear", "新建"], "new"],
  [["reconnect", "重连"], "reconnect"],
  [["stop", "停止"], "stop"],
];

test("splitCommand：trim 后以 / 开头才成命令，name 小写、rest trim", () => {
  assert.deepEqual(splitCommand("  /Help  xxx  "), { name: "help", rest: "xxx" });
  assert.equal(splitCommand("hello"), null);
  assert.deepEqual(splitCommand(" / "), { name: "", rest: "" });
});

test("简单命令别名表逐条命中", () => {
  for (const [aliases, type] of simpleAliases) {
    for (const alias of aliases) {
      assert.equal(parseBotCommand(`/${alias}`).type, type, `/${alias}`);
      // 大小写不敏感
      assert.equal(parseBotCommand(`/${alias.toUpperCase()}`).type, type, `/${alias}`);
    }
  }
});

test("cancel/取消 → selection.cancel；裸 0 → selection.cancel", () => {
  assert.equal(parseBotCommand("/cancel").type, "selection.cancel");
  assert.equal(parseBotCommand("/取消").type, "selection.cancel");
  assert.equal(parseBotCommand("0").type, "selection.cancel");
  assert.equal(parseBotCommand("  0  ").type, "selection.cancel");
});

test("bind：<code> 有 rest 成 bind，无 rest → unknown", () => {
  assert.deepEqual(parseBotCommand("/bind ABC123"), { type: "bind", code: "ABC123" });
  assert.equal(parseBotCommand("/bind").type, "unknown");
});

test("workspace/project/项目：无 rest list、有 rest set", () => {
  for (const alias of ["workspace", "project", "项目"]) {
    assert.equal(parseBotCommand(`/${alias}`).type, "workspace.list");
    assert.deepEqual(parseBotCommand(`/${alias} my-ws`), {
      type: "workspace.set",
      value: "my-ws",
    });
  }
});

test("model/模型：list、provider X、model X、裸值 set", () => {
  for (const alias of ["model", "模型"]) {
    assert.equal(parseBotCommand(`/${alias}`).type, "model.list");
    assert.deepEqual(parseBotCommand(`/${alias} provider glm`), {
      type: "model.provider.set",
      value: "glm",
    });
    assert.deepEqual(parseBotCommand(`/${alias} model gpt-x`), {
      type: "model.set",
      value: "gpt-x",
    });
    assert.deepEqual(parseBotCommand(`/${alias} gpt-x`), { type: "model.set", value: "gpt-x" });
  }
});

test("mode/模式、thoughtLevel 五别名、task、reply/回复：list/set 二态", () => {
  for (const alias of ["mode", "模式"]) {
    assert.equal(parseBotCommand(`/${alias}`).type, "mode.list");
    assert.deepEqual(parseBotCommand(`/${alias} yolo`), { type: "mode.set", value: "yolo" });
  }
  for (const alias of ["thoughtlevel", "thought_level", "thought-level", "think", "思考"]) {
    assert.equal(parseBotCommand(`/${alias}`).type, "thoughtLevel.list");
    assert.deepEqual(parseBotCommand(`/${alias} high`), {
      type: "thoughtLevel.set",
      value: "high",
    });
  }
  assert.equal(parseBotCommand("/task").type, "task.list");
  assert.deepEqual(parseBotCommand("/task t-1"), { type: "task.set", value: "t-1" });
  for (const alias of ["reply", "回复"]) {
    assert.equal(parseBotCommand(`/${alias}`).type, "reply.list");
    assert.deepEqual(parseBotCommand(`/${alias} 2`), { type: "reply.set", value: "2" });
  }
});

test("permission：须有 rest；elicitation/answer/回答：submit 词族与 respond", () => {
  assert.equal(parseBotCommand("/permission").type, "unknown");
  assert.deepEqual(parseBotCommand("/permission 2"), {
    type: "permission.respond",
    value: "2",
  });
  for (const alias of ["elicitation", "answer", "回答"]) {
    assert.equal(parseBotCommand(`/${alias}`).type, "unknown");
    for (const token of ["submit", "done", "完成", "提交"]) {
      assert.equal(parseBotCommand(`/${alias} ${token}`).type, "elicitation.submit");
    }
    assert.deepEqual(parseBotCommand(`/${alias} 3`), {
      type: "elicitation.respond",
      value: "3",
    });
  }
});

test("approve/deny：分词校验", () => {
  assert.deepEqual(parseBotCommand("/approve req-1 opt-a"), {
    type: "approve",
    requestId: "req-1",
    optionId: "opt-a",
  });
  assert.equal(parseBotCommand("/approve req-1").type, "unknown");
  assert.deepEqual(parseBotCommand("/deny req-1"), { type: "deny", value: "req-1" });
  assert.equal(parseBotCommand("/deny").type, "unknown");
});

test("未知命令 → unknown{name,raw}；普通文本 → message（原文不 trim）", () => {
  assert.deepEqual(parseBotCommand("/foobar x"), {
    type: "unknown",
    name: "foobar",
    raw: "/foobar x",
  });
  assert.deepEqual(parseBotCommand("  hello  "), { type: "message", text: "  hello  " });
});

test("数字语义：1-based 序号 / id-label 匹配 / \"0\" 与非数字清 pending", () => {
  const options = [
    { id: "opt-b", label: "Beta" },
    { id: "opt-a", label: "Alpha" },
  ];
  // resolveOptionByValue（ai）：正整数取第 n 项
  assert.equal(resolveSelectionOptionId(options, "1"), "opt-b");
  assert.equal(resolveSelectionOptionId(options, "2"), "opt-a");
  assert.equal(resolveSelectionOptionId(options, "3"), null);
  // id/label 小写匹配
  assert.equal(resolveSelectionOptionId(options, "OPT-A"), "opt-a");
  assert.equal(resolveSelectionOptionId(options, "beta"), "opt-b");
  // isSelectionIndexValue（Ale）：仅 [1-9]\d*；"0" 不是序号（走 selection.cancel 语义）
  assert.equal(isSelectionIndexValue("1"), true);
  assert.equal(isSelectionIndexValue("42"), true);
  assert.equal(isSelectionIndexValue("0"), false);
  assert.equal(isSelectionIndexValue("1a"), false);
  assert.equal(isSelectionIndexValue(" -1"), false);
});
