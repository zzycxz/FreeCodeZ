#!/usr/bin/env node
// 条目 9 真实 server e2e fixture：声明 resources + prompts capability 的 stdio MCP server。
// resources/list → [{uri, name}]；resources/read → [{uri, text}]；
// prompts/list → [{name, description, arguments}]；prompts/get → [{role, content}]。
import { Readable, Writable } from "node:stream";

const input = new Readable({ read() {} });
const output = new Writable({ write(chunk, _enc, cb) { process.stdout.write(chunk); cb(); } });

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.trim()) handleMessage(JSON.parse(line));
  }
});

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

function handleMessage(req) {
  if (req.method === "initialize") {
    send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-06-18", capabilities: { resources: {}, prompts: {} }, serverInfo: { name: "rp-fixture", version: "1.0" } } });
    return;
  }
  if (req.method === "notifications/initialized") return;
  if (req.method === "resources/list") {
    send({ jsonrpc: "2.0", id: req.id, result: { resources: [{ uri: "config://app", name: "App Config", mimeType: "text/plain" }, { uri: "data://users", name: "User List" }] } });
    return;
  }
  if (req.method === "resources/read") {
    const uri = req.params?.uri ?? "";
    send({ jsonrpc: "2.0", id: req.id, result: { contents: [{ uri, mimeType: "text/plain", text: `content of ${uri}` }] } });
    return;
  }
  if (req.method === "prompts/list") {
    send({ jsonrpc: "2.0", id: req.id, result: { prompts: [{ name: "review", description: "Review code", arguments: [{ name: "lang", description: "Language", required: true }] }, { name: "summarize", description: "Summarize text" }] } });
    return;
  }
  if (req.method === "prompts/get") {
    const name = req.params?.name ?? "";
    const lang = req.params?.arguments?.lang ?? "en";
    send({ jsonrpc: "2.0", id: req.id, result: { messages: [{ role: "user", content: { type: "text", text: `prompt ${name} in ${lang}` } }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Unknown method: ${req.method}` } });
}
