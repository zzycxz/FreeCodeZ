// P4b：SDK 操作展示上报（onCuaOperation）——display 复产的输入端。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ComputerUseSdk,
  type ComputerEngineTransport,
  type CuaOperationReport,
} from "../src/sdk/computer-use-sdk";

function transport(reply: { ok: boolean; result?: unknown; error?: { code?: string; message?: string } }): ComputerEngineTransport {
  return { request: async () => reply };
}

describe("P4b SDK 操作展示上报", () => {
  it("成功上报带结果与参数", async () => {
    const reports: CuaOperationReport[] = [];
    const sdk = new ComputerUseSdk({
      transport: transport({ ok: true, result: { treeText: "App=x" } }),
      sessionId: "s1",
      onCuaOperation: (op) => reports.push(op),
    });
    await sdk.listApps();
    assert.strictEqual(reports.length, 1);
    assert.deepStrictEqual(reports[0], {
      method: "listApps",
      ok: true,
      result: { treeText: "App=x" },
      params: {},
    });
  });

  it("引擎错误上报 G.2 错误码", async () => {
    const reports: CuaOperationReport[] = [];
    const sdk = new ComputerUseSdk({
      transport: transport({ ok: false, error: { code: "element_unavailable", message: "gone" } }),
      sessionId: "s1",
      onCuaOperation: (op) => reports.push(op),
    });
    await sdk
      .leftClick({
        target: { app: "TextEdit" },
        element: { kind: "element", index: 3 },
      })
      .catch(() => undefined);
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].ok, false);
    assert.strictEqual(reports[0].method, "click");
    assert.ok(reports[0].errorCode);
    assert.strictEqual(reports[0].params?.elementIndex, 3);
  });

  it("动作门关（actions_disabled）也上报——卡片如实显示被拒动作", async () => {
    const reports: CuaOperationReport[] = [];
    const sdk = new ComputerUseSdk({
      transport: transport({ ok: true, result: {} }),
      sessionId: "s1",
      actionsEnabled: false,
      onCuaOperation: (op) => reports.push(op),
    });
    await sdk.scroll({ target: { app: "TextEdit" }, deltaY: 3 }).catch(() => undefined);
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].ok, false);
    assert.strictEqual(reports[0].errorCode, "actions_disabled");
  });

  it("上报回调抛异常不折断操作本体（旁路口径）", async () => {
    const sdk = new ComputerUseSdk({
      transport: transport({ ok: true, result: 1 }),
      sessionId: "s1",
      onCuaOperation: () => {
        throw new Error("report boom");
      },
    });
    const result = await sdk.capabilities();
    assert.strictEqual(result, 1);
  });
});
