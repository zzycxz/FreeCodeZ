// 集成测试夹具：最小 stdio MCP server（NDJSON JSON-RPC）。
// 行为约定：
//   - initialize 响应前可延迟 SLOW_INIT_MS（模拟慢速远程 MCP，测缓存 connecting 窗口）；
//   - capabilities.tools.listChanged = true；
//   - 首次 tools/list 返回 v1（3 工具，其中 ui_only 声明 _meta.ui.visibility:["ui"]），
//     其后返回 v2（新增 gamma）——配合 initialized 后 150ms 主动推送
//     notifications/tools/list_changed，驱动 SDK autoRefresh 重拉验证订阅链路。
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const slowInitMs = Number(process.env.SLOW_INIT_MS ?? 0);
// C2 断连用例：EXIT_AFTER_MS 毫秒后直接退出进程，模拟 server 意外死亡
// （unexpected_disconnect → 装配层摘除幻影工具）。
const exitAfterMs = Number(process.env.EXIT_AFTER_MS ?? 0);
if (exitAfterMs > 0) {
  setTimeout(() => process.exit(1), exitAfterMs);
}
let listCalls = 0;

const toolsV1 = [
  {
    name: "alpha",
    description: "alpha tool",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "beta",
    description: "beta tool",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ui_only",
    description: "server-declared ui-only tool",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { visibility: ["ui"] } },
  },
];
const toolsV2 = [
  ...toolsV1,
  {
    name: "gamma",
    description: "added later via list_changed",
    inputSchema: { type: "object", properties: {} },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.method === "initialize") {
    const respond = () =>
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "minimal-fixture", version: "1.0.0" },
        },
      });
    if (slowInitMs > 0) {
      setTimeout(respond, slowInitMs);
    } else {
      respond();
    }
    return;
  }
  if (request.method === "notifications/initialized") {
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }, 150);
    return;
  }
  if (request.method === "tools/list") {
    listCalls += 1;
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: { tools: listCalls <= 1 ? toolsV1 : toolsV2 },
    });
    return;
  }
  if (request.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `method not found: ${request.method}` },
    });
  }
});
