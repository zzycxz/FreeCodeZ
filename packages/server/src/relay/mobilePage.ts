// 内嵌最小手机页（验证链路用；完整 mobileHome 是后续 P2 工作）。
// 页面读取链接里的 ?sid&hash&t&mid&name&app_version（由 /remote/v4 注入 __RELAY_CONFIG__），
// 连 /ws 发 mobile_hello，配对后发 bootstrap-request(requestId:"1") 渲染工作区/任务列表，
// 再回 mobile-view-state-update。样式全部内联，移动视口，深浅色跟随系统。
// 本文件同时承载手机侧握手契约（mobile_hello）与手机会话状态机。

import { relayDataEnvelopeSchema, type RelayErrorCode } from "@zcode/shared/web-remote-control";
import type { RelayConn } from "./pairingTable.js";
import {
  applyKicks,
  forwardData,
  parseTextFrame,
  pushPairStatus,
  rejectConnection,
  sendToMobile,
  toSession,
  type RelaySession,
  type RelaySessionDeps,
} from "./relayProtocol.js";

export interface MobilePageConfig {
  sid: string;
  hash: string;
  wsUrl: string;
  t?: string;
  mid?: string;
  name?: string;
  appVersion?: string;
}

/** FreeCodeZ 自定义手机握手帧：手机不持有 password，只持链接里的 sid+hash。 */
export interface MobileHelloFrame {
  type: "mobile_hello";
  sid: string;
  hash: string;
  client_ts?: number;
}

export function parseMobileHelloFrame(value: unknown): MobileHelloFrame | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  // 忽略未知字段（容错前向演进）：2026-09-26 真机排查发现白名单式拒绝会把任何带
  // 附加字段（如 name/app_version）的 hello 整帧打回 WRONG_PARAM，配对无谓失败。
  if (record["type"] !== "mobile_hello") return null;
  const sid = record["sid"];
  const hash = record["hash"];
  const clientTs = record["client_ts"];
  if (typeof sid !== "string" || sid.trim() === "") return null;
  if (typeof hash !== "string" || hash.trim() === "") return null;
  if (
    clientTs !== undefined &&
    (typeof clientTs !== "number" || !Number.isInteger(clientTs) || clientTs < 0)
  ) {
    return null;
  }
  return {
    type: "mobile_hello",
    sid: sid.trim(),
    hash: hash.trim(),
    ...(clientTs !== undefined ? { client_ts: clientTs } : {}),
  };
}

/** 手机端会话：mobile_hello（sid+hash）→ 配对 → data 转发。 */
export function createMobileSession(
  conn: RelayConn,
  deps: RelaySessionDeps,
  queryCreds: { sid?: string; hash?: string },
): RelaySession {
  const { table, logger, stats } = deps;
  let phase: "open" | "ready" | "closed" = "open";

  const fail = (code: RelayErrorCode, message: string): void => {
    if (phase === "closed") return;
    phase = "closed";
    logger.warn("mobile session closed", { connId: conn.connId, code, message });
    rejectConnection(conn, code, message, logger);
  };

  const handleHello = (value: unknown): void => {
    const hello = parseMobileHelloFrame(value);
    if (!hello) {
      fail("WRONG_PARAM", "expected mobile_hello");
      return;
    }
    // 查询参数与 hello 双源时必须一致（防链接被截断后误连）。
    if (queryCreds.sid && queryCreds.sid !== hello.sid) {
      fail("WRONG_PARAM", "sid mismatch");
      return;
    }
    if (queryCreds.hash && queryCreds.hash !== hello.hash) {
      fail("WRONG_PARAM", "hash mismatch");
      return;
    }
    const result = table.attachMobile(hello.sid, hello.hash, conn);
    if (!result.ok) {
      fail(
        "AUTH_FAILED",
        result.reason === "unknown-sid" ? "session-not-found" : "invalid-mobile-connection",
      );
      return;
    }
    phase = "ready";
    // 先应答本端 auth_ack，再踢旧手机与推送设备，保证同一连接上的帧序可预期。
    sendToMobile(conn, { type: "auth_ack", pair_status: result.entry.pairStatus }, logger);
    applyKicks(result.kicked, logger);
    pushPairStatus(result.entry, logger);
    logger.info("mobile paired", { connId: conn.connId, deviceSid: hello.sid });
  };

  const handleText = (text: string): void => {
    const parsed = parseTextFrame(text, conn, deps);
    if (!parsed.ok) {
      if (parsed.reason === "bad-json") fail("WRONG_PARAM", "invalid json");
      return;
    }
    if (phase === "open") {
      handleHello(parsed.value);
      return;
    }
    if (phase !== "ready") return;
    const value: unknown = parsed.value;
    if (
      typeof value === "object" &&
      value !== null &&
      (value as { type?: unknown }).type === "mobile_hello"
    ) {
      fail("WRONG_PARAM", "duplicate mobile_hello");
      return;
    }
    const envelope = relayDataEnvelopeSchema.safeParse(value);
    if (!envelope.success) {
      stats.invalidFramesDropped += 1;
      fail("WRONG_PARAM", "invalid mobile frame");
      return;
    }
    forwardData(conn, envelope.data, deps);
  };

  return toSession(conn, deps, () => phase === "closed", handleText);
}

function escapeJsonForScript(value: unknown): string {
  // JSON 内联进 <script>：转义 "<" 防止提前闭合脚本标签。
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function renderMobilePage(config: MobilePageConfig): string {
  const configJson = escapeJsonForScript(config);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>ZCode 移动端远程控制</title>
<style>
:root { color-scheme: light dark; --bg:#f5f6f8; --fg:#1c1f23; --muted:#6b7280; --card:#ffffff; --line:#e5e7eb; --ok:#16a34a; --bad:#dc2626; --wait:#d97706; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#111417; --fg:#e6e8ea; --muted:#9aa3ad; --card:#1b2026; --line:#2b323a; --ok:#34d399; --bad:#f87171; --wait:#fbbf24; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; padding:16px; }
header { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:12px; }
h1 { font-size:17px; margin:0; }
.sub { color:var(--muted); font-size:12px; margin-top:2px; }
.pill { font-size:12px; padding:4px 10px; border-radius:999px; border:1px solid var(--line); background:var(--card); white-space:nowrap; }
.pill.ok { color:var(--ok); border-color:var(--ok); }
.pill.bad { color:var(--bad); border-color:var(--bad); }
.pill.wait { color:var(--wait); border-color:var(--wait); }
section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin-bottom:12px; }
h2 { font-size:13px; margin:0 0 8px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
ul { list-style:none; margin:0; padding:0; }
li { padding:8px 0; border-top:1px solid var(--line); }
li:first-child { border-top:0; }
.item-title { font-weight:600; }
.item-meta { color:var(--muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tag { display:inline-block; font-size:11px; padding:1px 6px; border-radius:4px; border:1px solid var(--line); color:var(--muted); margin-left:6px; }
.empty { color:var(--muted); font-size:13px; }
button { font:inherit; padding:8px 16px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); }
#retry { display:none; margin-top:8px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>移动端远程控制</h1>
    <div class="sub" id="sub">最小验证页（完整 mobileHome 为后续 P2）</div>
  </div>
  <div class="pill wait" id="status">连接中…</div>
</header>
<section>
  <h2>工作区</h2>
  <ul id="workspaces"><li class="empty">等待 bootstrap…</li></ul>
</section>
<section>
  <h2>任务</h2>
  <ul id="tasks"><li class="empty">等待 bootstrap…</li></ul>
</section>
<button id="retry">重新连接</button>
<script>
window.__RELAY_CONFIG__ = ${configJson};
(function () {
  var config = window.__RELAY_CONFIG__ || {};
  var statusEl = document.getElementById("status");
  var subEl = document.getElementById("sub");
  var retryEl = document.getElementById("retry");
  var ws = null;
  var closed = false;
  if (config.name || config.appVersion) {
    subEl.textContent = (config.name || "ZCode") + (config.appVersion ? " · v" + config.appVersion : "");
  }

  function setStatus(kind, text) {
    statusEl.className = "pill " + kind;
    statusEl.textContent = text;
  }
  function esc(text) {
    return String(text == null ? "" : text).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
    });
  }
  function send(payload) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "data", payload: payload, client_ts: Date.now() }));
    }
  }
  function requestBootstrap() {
    send({ zcode_type: "bootstrap-request", requestId: "1" });
    setStatus("wait", "已连接，加载数据…");
  }
  function sendViewState() {
    send({
      zcode_type: "mobile-view-state-update",
      viewState: { updatedAt: Date.now() },
      deviceInfo: {
        platform: navigator.platform || "mobile",
        version: config.appVersion || "0",
        name: config.name || "mobile-web",
        userAgent: navigator.userAgent,
        viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 },
        screen: { width: screen.width, height: screen.height },
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        online: navigator.onLine,
        updatedAt: Date.now()
      }
    });
  }
  function renderList(elementId, items, renderOne) {
    var ul = document.getElementById(elementId);
    ul.innerHTML = "";
    if (!items || items.length === 0) {
      ul.innerHTML = '<li class="empty">（空）</li>';
      return;
    }
    for (var i = 0; i < items.length; i++) {
      var li = document.createElement("li");
      li.innerHTML = renderOne(items[i]);
      ul.appendChild(li);
    }
  }
  function renderBootstrap(result) {
    renderList("workspaces", result && result.workspaces, function (workspace) {
      return '<div class="item-title">' + esc(workspace.label) +
        '<span class="tag">' + esc(workspace.kind) + '</span></div>' +
        '<div class="item-meta">' + esc(workspace.workspaceIdentity || workspace.workspacePath) + '</div>';
    });
    renderList("tasks", result && result.tasks, function (task) {
      return '<div class="item-title">' + esc(task.title || task.taskId) +
        (task.displayStatus ? '<span class="tag">' + esc(task.displayStatus) + '</span>' : '') + '</div>' +
        '<div class="item-meta">' + esc(task.workspaceLabel) + '</div>';
    });
  }
  function terminate(kind, text) {
    closed = true;
    setStatus(kind, text);
    retryEl.style.display = "inline-block";
    if (ws) { try { ws.close(); } catch (e) { /* 已断开 */ } }
  }
  function handleMessage(frame) {
    if (frame.type === "auth_ack") {
      setStatus(frame.pair_status === "matched" ? "ok" : "wait",
        frame.pair_status === "matched" ? "已连接桌面" : "等待配对");
      if (frame.pair_status === "matched") requestBootstrap();
    } else if (frame.type === "pair_status_ack") {
      setStatus(frame.pair_status === "matched" ? "ok" : "wait",
        frame.pair_status === "matched" ? "已连接桌面" : "等待配对");
    } else if (frame.type === "error") {
      if (frame.code === "KICKED") {
        terminate("bad", "已在其他页面打开，本页已断开");
      } else {
        terminate("bad", "连接失败：" + frame.code + (frame.message ? "（" + frame.message + "）" : ""));
      }
    } else if (frame.type === "data" && frame.payload && typeof frame.payload === "object") {
      var payload = frame.payload;
      if (payload.zcode_type === "bootstrap-response" && payload.requestId === "1") {
        renderBootstrap(payload.result);
        setStatus("ok", "已连接桌面");
        sendViewState();
      } else if (payload.zcode_type === "app-error") {
        terminate("bad", payload.reason + (payload.error ? "：" + payload.error : ""));
      }
    }
  }
  function connect() {
    if (!config.sid || !config.hash) {
      setStatus("bad", "链接无效：缺少 sid/hash");
      return;
    }
    setStatus("wait", "连接中…");
    ws = new WebSocket(config.wsUrl + "?sid=" + encodeURIComponent(config.sid) +
      "&hash=" + encodeURIComponent(config.hash));
    ws.onopen = function () {
      setStatus("wait", "已连接，正在配对…");
      ws.send(JSON.stringify({ type: "mobile_hello", sid: config.sid, hash: config.hash, client_ts: Date.now() }));
    };
    ws.onmessage = function (event) {
      try { handleMessage(JSON.parse(event.data)); } catch (e) { /* 忽略坏帧 */ }
    };
    ws.onclose = function () {
      if (!closed) terminate("bad", "连接已断开");
    };
    ws.onerror = function () { /* onclose 统一收口 */ };
  }
  retryEl.onclick = function () { closed = false; retryEl.style.display = "none"; connect(); };
  connect();
})();
</script>
</body>
</html>`;
}
