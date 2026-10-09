// W-28 帧发射断言：坐标点击 point/down/up、拖拽三帧、type/paste text loading 帧、
// key 帧；元素点击不发帧（坐标不可知，旁路可视化不折断动作）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ComputerUseSdk, type ComputerEngineTransport } from "../src/sdk/computer-use-sdk";

function sinkTransport(): { transport: ComputerEngineTransport; frames: Array<{ kind: string }> } {
  const frames: Array<{ kind: string }> = [];
  return {
    frames,
    transport: {
      async request() {
        return { ok: true, result: {} };
      },
    },
  };
}

describe("SDK HUD 帧发射（W-28）", () => {
  it("坐标点击发 point/down/up；元素点击不发", async () => {
    const { transport, frames } = sinkTransport();
    const sdk = new ComputerUseSdk({
      transport,
      sessionId: "s",
      platform: "darwin",
      onInputEvent: (e) => frames.push(e as { kind: string }),
    });
    await sdk.leftClick({
      target: { app: "Finder" },
      element: { kind: "coordinate", x: 400, y: 200, scale: 2 },
    });
    assert.deepStrictEqual(
      frames.map((f) => f.kind),
      ["point", "down", "up"],
    );
    frames.length = 0;
    await sdk.leftClick({ target: { app: "Finder" }, element: { kind: "element", index: 3 } });
    assert.deepStrictEqual(frames, [], "元素点击坐标不可知不发帧");
  });

  it("拖拽三帧、key 帧、type/paste text loading 帧", async () => {
    const { transport, frames } = sinkTransport();
    const sdk = new ComputerUseSdk({
      transport,
      sessionId: "s",
      platform: "darwin",
      onInputEvent: (e) => frames.push(e as { kind: string }),
    });
    await sdk.drag({
      target: { app: "Finder" },
      from: { kind: "coordinate", x: 0, y: 0 },
      to: { kind: "coordinate", x: 100, y: 50 },
    });
    await sdk.key({ target: { app: "Finder" }, key: "Return" });
    await sdk.type({ target: { app: "Finder" }, text: "hello" });
    await sdk.paste({ target: { app: "Finder" }, text: "world" });
    assert.deepStrictEqual(
      frames.map((f) => f.kind),
      ["drag_start", "point", "drag_end", "key", "text", "text"],
    );
  });
});
