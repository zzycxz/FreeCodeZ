// 测试共用:helper 线协议 mock(NDJSON + authenticate 首请求门 + 可编程失败模式)。
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function mockSocketPath() {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\zcode-cua-test-${randomUUID()}`
    : join(tmpdir(), `zcode-cua-test-${randomUUID()}.sock`);
}

/**
 * handlers[method](params) 返回:
 *   普通对象        → ok:true result
 *   {__error:{...}} → ok:false error
 *   {__destroy}     → 读到请求后直接断连(possibly_sent 判定路径)
 *   {__silent}      → 读到请求后不回(超时路径)
 */
export async function startMockHelper(options = {}) {
  const socketPath = options.socketPath ?? mockSocketPath();
  const handlers = options.handlers ?? {};
  const enforceAuthenticate = options.enforceAuthenticate !== false;
  const calls = [];
  const connections = [];
  const server = createServer((socket) => {
    let authenticated = false;
    let buffer = "";
    connections.push(socket);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          continue;
        }
        const respond = (payload) => {
          if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`);
        };
        calls.push({ method: request.method, params: request.params, id: request.id });
        if (request.method === "authenticate") {
          authenticated = true;
          respond({ id: request.id, ok: true, result: { authenticated: true } });
          continue;
        }
        if (enforceAuthenticate && !authenticated) {
          respond({
            id: request.id,
            ok: false,
            error: { code: "not_authorized", message: "authenticate must be the first request" },
          });
          continue;
        }
        const handler = handlers[request.method];
        if (!handler) {
          respond({
            id: request.id,
            ok: false,
            error: { code: "method_not_found", message: `unknown method ${request.method}` },
          });
          continue;
        }
        const outcome = handler(request.params);
        if (outcome?.__destroy) {
          socket.destroy();
          continue;
        }
        if (outcome?.__silent) continue;
        if (outcome?.__error) {
          respond({ id: request.id, ok: false, error: outcome.__error });
          continue;
        }
        respond({ id: request.id, ok: true, result: outcome });
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    calls,
    methods: () => calls.map((call) => call.method),
    close: async () => {
      for (const socket of connections) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 最小 PNG 字节(readPngSize 只读签名+IHDR,CRC 不校验)。 */
export function fakePng(width = 20, height = 10) {
  const buffer = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

export const CONTEXT = Object.freeze({
  sessionId: "session-1",
  runtimeScope: "main",
  workspaceKey: "workspace-1",
});

export function captureAppFixture(elements = undefined) {
  return {
    app: {
      bundle_id: "com.example.App",
      pid: 42,
      name: "Example",
      aumid: undefined,
      executable_path: "C:\\Apps\\example.exe",
      icon_png: null,
    },
    window: { title: "Example Window", bounds: [0, 0, 800, 600], window_id: 7 },
    elements: elements ?? [
      {
        role: "AXButton",
        kind: "button",
        title: "OK",
        value: null,
        bounds: [10, 10, 50, 20],
        actions: ["AXPress"],
        native: "ax-1",
        owner_pid: 42,
        enabled: true,
        pressable: true,
      },
      {
        role: "AXTextField",
        kind: "textfield",
        title: "Name",
        value: "hello",
        bounds: [10, 40, 200, 24],
        actions: [],
        native: "ax-2",
        owner_pid: 42,
        enabled: true,
        editable: true,
      },
    ],
    screenshot: { format: "png", data: fakePng(20, 10).toString("base64") },
    screenshot_blank: false,
    state_id: "h-1",
    coordinate_contract: "frame_pixel_projection_v1",
    pointer: { x: 0, y: 0, width: 20, height: 10, unit: "physical_pixel" },
    display: { id: 1, topology_fingerprint: "topo-1" },
    snapshot_mode: "full",
  };
}
