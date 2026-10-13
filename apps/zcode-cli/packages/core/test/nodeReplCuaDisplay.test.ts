// P4b：createNodeReplDisplay 消费桥下行的 freecodez/nodeReplCuaDisplay——
// kind:"cua" 透传（校验+限界），混合 run 浏览器图片并入 media，非 cua 走图片路径。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolResultDisplay } from "../src/tool/executor/result-display.js";

function jsOutput(responseMeta: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { result: "ok", responseMeta, ...extra };
}

describe("P4b node-repl CUA display 透传", () => {
  it("cua display meta → display 落位（kind/toolName/status）", () => {
    const display = createToolResultDisplay("mcp__node_repl__js", jsOutput({
      "freecodez/nodeReplCuaDisplay": {
        kind: "cua",
        schemaVersion: 1,
        toolName: "get_app_state",
        status: "success",
        text: "App=TextEdit (pid 42)",
      },
    }));
    assert.ok(display);
    assert.strictEqual(display.kind, "cua");
    assert.ok(display.kind === "cua" && display.toolName === "get_app_state");
    assert.ok(display.kind === "cua" && display.text === "App=TextEdit (pid 42)");
  });

  it("形状不符（缺 toolName/status 非法/非 cua）一律拒收", () => {
    assert.equal(
      createToolResultDisplay("mcp__node_repl__js", jsOutput({
        "freecodez/nodeReplCuaDisplay": { kind: "cua", schemaVersion: 1, status: "success" },
      })),
      undefined,
    );
    assert.equal(
      createToolResultDisplay("mcp__node_repl__js", jsOutput({
        "freecodez/nodeReplCuaDisplay": { kind: "cua", schemaVersion: 1, toolName: "x", status: "weird" },
      })),
      undefined,
    );
    assert.equal(
      createToolResultDisplay("mcp__node_repl__js", jsOutput({
        "freecodez/nodeReplCuaDisplay": { kind: "node_repl_images", schemaVersion: 1, toolName: "x", status: "success" },
      })),
      undefined,
    );
  });

  it("字段限界：超长 text/input 被裁、超限 media 数据丢弃", () => {
    const display = createToolResultDisplay("mcp__node_repl__js", jsOutput({
      "freecodez/nodeReplCuaDisplay": {
        kind: "cua",
        schemaVersion: 1,
        toolName: "type_text",
        status: "success",
        text: "x".repeat(40_000),
        input: JSON.stringify({ text: "y".repeat(10_000) }),
        media: [{ mimeType: "image/png", data: "z".repeat(400_000) }],
      },
    }));
    assert.ok(display && display.kind === "cua");
    assert.ok(display.text && display.text.length <= 16 * 1024);
    assert.ok(display.input && display.input.length <= 16 * 1024);
    // 超 schema 上限（349528）的图片数据整条丢弃。
    assert.equal(display.media, undefined);
  });

  it("混合 run：浏览器图片并入 cua display 的 media", () => {
    const display = createToolResultDisplay("mcp__node_repl__js", jsOutput(
      {
        "freecodez/nodeReplCuaDisplay": {
          kind: "cua",
          schemaVersion: 1,
          toolName: "click",
          status: "success",
          media: [{ mimeType: "image/png", data: "aGk=" }],
        },
      },
      { images: [{ mimeType: "image/png", base64: "aGk=" }] },
    ));
    assert.ok(display && display.kind === "cua");
    assert.strictEqual(display.media?.length, 2);
  });

  it("无 cua meta 时保持既有图片路径（node_repl_images）", () => {
    const display = createToolResultDisplay("mcp__node_repl__js", {
      result: "x",
      images: [{ mimeType: "image/png", base64: "aGk=" }],
    });
    assert.ok(display && display.kind === "node_repl_images");
    assert.strictEqual(display.images.length, 1);
  });
});
