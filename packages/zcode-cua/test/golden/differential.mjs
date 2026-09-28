// I.2-2 差分测试驱动器:官方 NRH 链 vs 补位 NRH 链,同机同探针(js cell)。
// 允许差异白名单 = §1.1-A + H.3-2 品牌映射;白名单外零差异 = A23 通过。
// 用法:node packages/zcode-cua/test/golden/differential.mjs
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OFFICIAL = "C:/Users/13852/Downloads/zcode-3.14.3-unpacked/app";
const REPO = process.cwd();

const SIDES = {
  official: {
    server: join(OFFICIAL, "resources/glm/packages/node-repl-host/dist/mcp/server.js"),
    pluginRoot: join(OFFICIAL, "resources/glm/packages/zcode-cua-plugin"),
    helperRoot: join(OFFICIAL, "resources/tools/cua-helper"),
  },
  ours: {
    server: join(REPO, "apps/zcode-cli/packages/node-repl-host/dist/mcp/server.js"),
    pluginRoot: join(REPO, "apps/zcode-cli/dependencies/zcode-cua/plugin"),
    helperRoot: join(REPO, "apps/zcode-cli/dependencies/zcode-cua/helper-runtime"),
  },
};

function pipeName() {
  const BS = String.fromCharCode(92);
  return [BS, BS, ".", BS, "pipe", BS, "zcode-diff-", randomUUID()].join("");
}

async function startHelper(helperRoot, socketPath) {
  const { spawn: nodeSpawn } = await import("node:child_process");
  const entry = join(helperRoot, "dist", "windows-helper.js");
  const addon = join(helperRoot, "build", "Release", "ax_native.node");
  const child = nodeSpawn(
    process.execPath,
    [entry, "--socket", socketPath, "--parent-pid", String(process.pid)],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ZCODE_CUA_HELPER_ADDON: addon, ZCODE_CUA_DEV_MODE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("helper ready timeout")), 30000);
    child.on("message", (message) => {
      if (message?.type === "ready") {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => reject(new Error(`helper exited ${code}`)));
  });
  return child;
}

// 最小 MCP stdio 客户端(newline-delimited JSON-RPC)
function mcpSession(child) {
  let nextId = 1;
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
    }
  });
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`mcp timeout: ${method}`));
        }
      }, 120000);
    });
  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  return { send, notify };
}

async function runProbes(sideName) {
  const side = SIDES[sideName];
  if (!existsSync(side.server)) throw new Error(`missing ${side.server}`);
  const socketPath = pipeName();
  const helper = await startHelper(side.helperRoot, socketPath);
  const sdkUrl = `file:///${join(side.pluginRoot, "scripts", "computer-use-client.mjs").replaceAll("\\", "/")}`;
  const child = spawn(process.execPath, [side.server], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ZCODE_CUA_PERMISSION_BROKER_SOCKET: socketPath,
      ZCODE_CUA_PLUGIN_ROOT: side.pluginRoot,
      ZCODE_PLUGIN_ID: "computer-use@zcode-plugins-official",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (c) => stderr.push(c.toString("utf8")));
  const mcp = mcpSession(child);
  const outputs = {};
  try {
    let init;
    let lastError;
    for (const version of ["2026-07-28", "2024-11-05", "2025-06-18"]) {
      try {
        init = await mcp.send("initialize", {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: "a23-differential", version: "0.0.0" },
        });
        break;
      } catch (error) {
        lastError = error;
        if (!String(error).includes("Unsupported protocol version")) throw error;
      }
    }
    if (!init) throw lastError ?? new Error("no supported MCP protocol version");
    mcp.notify("notifications/initialized", {});
    const probe = (code) =>
      mcp.send("tools/call", { name: "js", arguments: { code, title: "diff" } }).then((result) =>
        (result?.content ?? []).map((block) => block.text ?? "").join("\n"),
      );
    const bootstrap = `const { setupComputerUseRuntime } = await import(${JSON.stringify(sdkUrl)});await setupComputerUseRuntime({ globals: globalThis });`;
    // P1: listApps
    outputs.listApps = await probe(
      `${bootstrap}const r = await agent.computerUse.listApps({ emit: false });nodeRepl.write(JSON.stringify(r));`,
    );
    // P2: 观察树(Notepad/记事本)
    outputs.tree = await probe(
      `${bootstrap}const all = await agent.computerUse.listApps({ emit: false });const t = all.apps.find((a) => /notepad|记事本/i.test(String(a.name)) || /notepad/i.test(String(a.bundle_id))) ?? all.apps[0];const app = await agent.computerUse.getApp(t);const tree = await app.getAXState({ emit: false });nodeRepl.write(tree);`,
    );
    // P3: 死 token 错误面
    outputs.errorPath = await probe(
      `${bootstrap}const all = await agent.computerUse.listApps({ emit: false });const t = all.apps.find((a) => /notepad|记事本/i.test(String(a.name)) || /notepad/i.test(String(a.bundle_id))) ?? all.apps[0];const app = await agent.computerUse.getApp(t);try { await app.setValue(9999, "x"); nodeRepl.write("NO-ERROR"); } catch (e) { nodeRepl.write(JSON.stringify({ name: e.name, code: e.code, retry: e.retry, actionSent: e.actionSent, message: e.message })); }`,
    );
    // P4: request_access 快照
    outputs.requestAccess = await probe(
      `${bootstrap}const r = await agent.computerUse.requestAccess();nodeRepl.write(JSON.stringify(r));`,
    );
  } finally {
    child.kill();
    helper.kill();
  }
  if (!outputs.listApps) throw new Error(`empty outputs on ${sideName}: ${stderr.join("").slice(0, 500)}`);
  return outputs;
}

function normalize(text) {
  return String(text)
    .replace(/\bpid=\d+/g, "pid=#")
    .replace(/"pid":\d+/g, '"pid":#')
    .replace(/window_id=\d+/g, "window_id=#")
    .replace(/"window_id":\d+/g, '"window_id":#')
    .replace(/\bs-\d+/g, "s-#")
    .replace(/\bax-[a-zA-Z0-9-]+/g, "ax-#")
    .replace(/frame-[a-zA-Z0-9-]+/g, "frame-#")
    .replace(/"state_id":"[^"]+"/g, '"state_id":"#"')
    .replace(/"capture_epoch":"[^"]+"/g, '"capture_epoch":"#"')
    .replace(/ZCode Computer Use/g, "FreeCodeZ Computer Use")
    .replace(/\bZCode\b/g, "FreeCodeZ")
    .replace(/\bZ\.ai\b/g, "FreeCodeZ");
}

const [ours, official] = await Promise.all([
  runProbes("ours"),
  runProbes("official"),
]);
const report = { comparedAt: new Date().toISOString(), probes: {} };
let clean = true;
for (const key of Object.keys(ours)) {
  const a = normalize(ours[key]);
  const b = normalize(official[key]);
  const match = a === b;
  report.probes[key] = { match, ours: a, official: b };
  if (!match) clean = false;
  console.log(`${match ? "MATCH" : "DIFF "} ${key}`);
}
writeFileSync(
  join(REPO, "packages/zcode-cua/test/golden/fixtures/differential-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
console.log(clean ? "A23 differential: zero diff outside brand whitelist" : "A23 differential: DIFFERENCES FOUND (see report)");
process.exit(clean ? 0 : 1);
