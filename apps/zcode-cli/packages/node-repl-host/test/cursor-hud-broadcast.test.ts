// V1.19 P3（W-28 收口）回归：光标 HUD 帧出口——桥层广播器把 SDK 输入事件
// JSON 单播到 127.0.0.1 的 HUD 监听端口（desktop cuaCursorHud 同款绑定）。
// 断链背景：SDK 发射面与桌面监听早已在位，桥层缺 onInputEvent 接线——
// 本测试钉住桥→UDP→帧 JSON 全链。
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import test from "node:test";
import { createCursorHudBroadcaster } from "../src/computer-bridge.js";

test("P3：事件 JSON 单播到 env 指定端口（127.0.0.1），close 幂等", async () => {
  const listener = createSocket("udp4");
  listener.bind(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const port = (listener.address() as { port: number }).port;
  const broadcaster = createCursorHudBroadcaster({
    FREECODEZ_CUA_CURSOR_BROADCAST_PORT: String(port),
  } as NodeJS.ProcessEnv);

  const received = new Promise<string>((resolve) =>
    listener.once("message", (message) => resolve(message.toString("utf8"))),
  );
  broadcaster.emit({ v: 1, kind: "point", x: 10, y: 20 });
  const frame = JSON.parse(await received) as { v: number; kind: string; x: number; y: number };
  assert.equal(frame.v, 1);
  assert.equal(frame.kind, "point");
  assert.equal(frame.x, 10);
  assert.equal(frame.y, 20);

  broadcaster.close();
  broadcaster.close(); // 双 close 防御不抛。
  listener.close();
});

test("P3：emit 异常不外抛（旁路可视化不折断动作本体）", () => {
  const broadcaster = createCursorHudBroadcaster({
    FREECODEZ_CUA_CURSOR_BROADCAST_PORT: "not-a-port",
  } as NodeJS.ProcessEnv);
  broadcaster.emit({ v: 1, kind: "text", detail: "x" }); // Number() NaN → 默认 53717；发往无人监听端口也不抛。
  broadcaster.close();
  assert.ok(true);
});
