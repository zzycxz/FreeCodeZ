// V1.19 P5（R7/A15）回归：敏感字段树行值脱敏——getAppState 是模型读树唯一入口，
// readElement 复用同享。行格式锚点=Swift SnapshotRendering.line（", Value: …"/", Text: …"）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ComputerUseSdk, redactTreeText, type ComputerEngineTransport } from "../src/sdk/computer-use-sdk";

describe("redactTreeText（V1.19 P5）", () => {
  it("密码族行：Value/Text 段替换为 [redacted]，名称保留供定位", () => {
    const tree = [
      "App=com.example (pid 1)",
      '42 secure text field "密码", Value: hunter2, Placeholder: 请输入密码',
      "43 button 登录",
      '44 text entry area "API Token", Text: sk-1234567890',
    ].join("\n");
    const out = redactTreeText(tree);
    assert.ok(out.includes('42 secure text field "密码", Value: [redacted]'), out);
    assert.ok(!out.includes("hunter2"));
    assert.ok(!out.includes("sk-1234567890"));
    assert.ok(out.includes("43 button 登录"), "非敏感行不动");
  });

  it("全文无敏感词走快路径（逐字节不变）", () => {
    const tree = 'App=Finder (pid 1)\n7 button "新建文件夹"';
    assert.equal(redactTreeText(tree), tree);
  });

  it("敏感名但无值段的行不变形（如 Generate Token 按钮）", () => {
    const line = '51 button "Generate Token"';
    assert.equal(redactTreeText(line), line);
  });

  it("中文密码/密钥命中；PIN 单词边界不误伤 Pinning", () => {
    assert.ok(redactTreeText('9 text field "密钥", Value: abc').includes("[redacted]"));
    assert.ok(!redactTreeText('9 text field "Pinning", Value: keep-me').includes("[redacted]"));
  });
});

describe("getAppState 集成（V1.19 P5）", () => {
  it("引擎返回的 treeText 经 SDK 出口已脱敏（readElement 复用同享）", async () => {
    const transport: ComputerEngineTransport = {
      async request() {
        return {
          ok: true,
          result: {
            snapshot: {
              id: "s1",
              treeText: 'App=com.example (pid 1)\n42 secure text field "密码", Value: hunter2',
              focusedElementId: 42,
            },
          },
        };
      },
    };
    const sdk = new ComputerUseSdk({ transport, sessionId: "s", platform: "darwin" });
    const state = (await sdk.getAppState({ app: "com.example" })) as {
      snapshot: { treeText: string };
    };
    assert.ok(state.snapshot.treeText.includes("[redacted]"));
    assert.ok(!state.snapshot.treeText.includes("hunter2"));
  });
});
