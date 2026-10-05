// I.2-1 金样本夹具录制器:直连官方 windows-helper.js(独立进程 + NDJSON 命名管道,
// ZCODE_CUA_HELPER_ADDON 指官方 ax_native.node,ZCODE_CUA_DEV_MODE=1 绕 peer 门),
// 对 42+2 方法录制 request/response 金样本(含错误路径)。金样本 = B2 单测断言基准。
//
// 用法:node packages/zcode-cua/test/golden/record.mjs [--out <fixture.json>]
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OFFICIAL =
  (process.env.FREECODEZ_CUA_ASSET_SOURCE ?? process.env.ZCODE_CUA_ASSET_SOURCE)?.replace(/resources\/?$/u, "") ||
  "C:/Users/13852/Downloads/zcode-3.14.3-unpacked/app";
const HELPER_ROOT = join(OFFICIAL, "resources", "tools", "cua-helper");
const here = dirname(fileURLToPath(import.meta.url));

// 大载荷(截图 base64)只存指纹,金样本保形即可回放。
function normalizePayload(value) {
  if (typeof value === "string" && value.length > 4096) {
    return {
      __truncated: true,
      bytes: value.length,
      sha256: createHash("sha256").update(value).digest("hex"),
    };
  }
  if (Array.isArray(value)) return value.map(normalizePayload);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = normalizePayload(entry);
    return out;
  }
  return value;
}

function rawCall(socketPath, payload, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timeout waiting for ${payload.method}`));
    }, timeoutMs);
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      const line = buffer.slice(0, nl);
      socket.destroy();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main() {
  const pipe =
    process.platform === "win32"
      ? [String.fromCharCode(92,92), ".", String.fromCharCode(92), "pipe", String.fromCharCode(92), "zcode-golden-", randomUUID()].join("")
      : join("/tmp", `zcode-golden-${randomUUID()}.sock`);
  const entry = join(HELPER_ROOT, "dist", "windows-helper.js");
  const addon = join(HELPER_ROOT, "build", "Release", "ax_native.node");
  if (!existsSync(entry) || !existsSync(addon)) {
    throw new Error(`official helper assets missing under ${HELPER_ROOT}`);
  }

  const child = spawn(
    process.execPath,
    ["--no-warnings", entry, "--socket", pipe, "--parent-pid", String(process.pid)],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ZCODE_CUA_HELPER_ADDON: addon,
        ZCODE_CUA_DEV_MODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("helper ready timeout")), 30000);
    child.on("message", (message) => {
      if (message?.type === "ready") {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stdout?.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        try {
          const parsed = JSON.parse(line);
          if (parsed?.type === "ready") {
            clearTimeout(timer);
            resolve();
          }
        } catch {}
      }
    });
    child.on("exit", (code) => reject(new Error(`helper exited ${code}: ${stderr.join("")}`)));
  });

  // 观测/动作组需要一个真实可见目标:先拉起 Notepad。
  spawn("notepad.exe", [], { detached: true, stdio: "ignore" }).unref();
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const cases = [];
  let nextId = 100;
  async function record(name, method, params, options = {}) {
    const request = { id: nextId++, method, ...(params !== undefined ? { params } : {}) };
    let response;
    try {
      response = await rawCall(pipe, request, options);
    } catch (error) {
      response = { transportError: String(error) };
    }
    cases.push({ name, request: normalizePayload(request), response: normalizePayload(response) });
    return response;
  }

  // ── 连接级 ──
  const auth = (id) => ({
    id,
    method: "authenticate",
    params: {
      clientApiVersion: 2,
      client_type: "zcode_cua_mcp",
      workspace_key: "golden-ws",
      session_id: "golden-session",
      thread_id: "golden-thread",
      connection_id: `golden-${id}`,
    },
  });
  await record("ping", "ping", {});
  // version_mismatch:clientApiVersion>2(未认证路径)
  await record("error/client_api_version_mismatch", "authenticate", {
    clientApiVersion: 3,
    client_type: "zcode_cua_mcp",
    workspace_key: "golden-ws",
    session_id: "golden-session",
    thread_id: "golden-thread",
    connection_id: "golden-v3",
  });
  // not_authorized:未认证首请求即业务方法(每条 rawCall 都是新连接)
  // 金样本事实(勘误证据手册 §3.5「必须 authenticate 首请求」的绝对化表述):
  // exe 对 pre-auth 的 broker_info 直接放行(即 claim 语义),业务方法 pre-auth 单独探明。
  await record("pre_auth_broker_info_claim_semantics", "broker_info", {});
  await record("pre_auth_business_call", "list_applications", {});

  await record("authenticate_ok", "authenticate", auth(2).params);
  const claim = await record("broker_info_claim", "broker_info", {});

  // ── 诊断组(10) ──
  await record("controller_status", "controller_status", {});
  await record("request_access_readonly", "request_access", { capabilities: [] });
  await record("permission_status", "permission_status", {});
  await record("input_permission_status", "input_permission_status", {});
  await record("screen_capture_status", "screen_capture_status", {});
  await record("supports_accessibility", "supports_accessibility", {});

  // ── 观测组 ──
  const appsResp = await record("list_applications", "list_applications", {});
  const apps = Array.isArray(appsResp?.result) ? appsResp.result : (appsResp?.result?.apps ?? []);
  const target =
    apps.find((a) => /notepad|记事本/i.test(String(a.name)) || /notepad/i.test(String(a.bundle_id))) ??
    apps.find((a) => /calc|计算器/i.test(String(a.name))) ??
    apps[0];
  const pid = target?.pid;
  await record("list_windows", "list_windows", pid ? { app_ref: { pid } } : { app_ref: { name: "Notepad" } });
  const appRef = pid ? { pid } : { name: "Notepad" };
  const capture = await record("capture_app_tree", "capture_app", {
    app_ref: appRef,
    include_screenshot: false,
    tree_shown_to_model: true,
  });
  await record("capture_app_screenshot", "capture_app", {
    app_ref: appRef,
    include_screenshot: true,
    tree_shown_to_model: true,
  });
  await record("capture_app_hidden_tree", "capture_app", {
    app_ref: appRef,
    include_screenshot: false,
    tree_shown_to_model: false,
  });
  const elements = capture?.result?.elements ?? [];
  const token = elements.find((e) => e.native)?.native;
  const settable = elements.find((e) => e.editable && e.native)?.native;
  const pressable = elements.find((e) => (e.actions ?? []).includes("AXPress") && e.native)?.native;
  if (token) await record("read_element", "read_element", { native: token });
  await record("error/element_unavailable_bad_token", "read_element", { native: "ax-deadbeef-999" });
  if (settable) {
    await record("element_set_value_ok", "element_set_value", { native: settable, value: "golden" });
  }
  const nonSettable = elements.find((e) => !e.editable && e.native)?.native;
  if (nonSettable) {
    await record("error/not_settable", "element_set_value", { native: nonSettable, value: "x" });
    await record("error/not_selectable", "element_select_text", {
      native: nonSettable,
      text_range: [0, 1],
    });
  }
  if (pressable) {
    await record("element_perform_action_invalid", "element_perform_action", {
      native: pressable,
      action: "AXNoSuchAction",
    });
    await record("element_press_ok", "element_press", { native: pressable });
  }
  await record("element_at_point", "element_at_point", { x: 5, y: 5 });

  // ── 动作组错误路径 ──
  await record("error/text_too_long", "type_text", { text: "x".repeat(2000) });
  await record("error/bad_frame_provenance", "click", {
    point: [10, 10],
    button: "left",
    clicks: 1,
    modifiers: "",
    frame_provenance: [
      {
        contract: "frame_pixel_projection_v1",
        frame_id: "frame-forged",
        expires_at_ms: Date.now() + 60000,
        delivered: { width: 10, height: 10 },
        source: { width: 10, height: 10, crop: { left: 0, top: 0, right: 10, bottom: 10 } },
        pointer: { x: 0, y: 0, width: 10, height: 10, unit: "physical_pixel" },
        pixel: { x: 5, y: 5 },
        projected_point: [5, 5],
        endpoint_index: 0,
      },
    ],
  });
  await record("error/method_not_found", "bogus_method_xyz", {});
  await record("cancel_input_holds", "cancel_input_holds", {});

  // ── 防抢焦点组(3) ──
  await record("prevent_activation", "prevent_activation", {});
  await record("is_focus_steal_prevented", "is_focus_steal_prevented", {});
  await record("reenable_activation", "reenable_activation", {});

  // ── PiP 只读 + 角色门(A18/R15 金样本) ──
  await record("pip_is_running", "pip_is_running", {});
  await record("pip_clear_dismissed", "pip_clear_dismissed", {});
  await record("error/pip_session_requires_presentation", "pip_session_handshake", {
    protocolVersion: 2,
    runtimeId: "zcode-cua-pip-session-v2",
  });
  await record("error/pip_session_event_requires_presentation", "pip_session_event", {
    event: { kind: "session-closed", sessionId: "s" },
  });

  // controller_busy 活体构造需并发在途动作,helper 侧不保证稳定;工具层租约语义由
  // tool-runtime.test.mjs(A6)覆盖,helper 侧 admitControllerAction 见附录 A.2 补充约束。

  child.kill();
  const fixture = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    helperSource: "official-zcode-3.14.3-windows-helper",
    helperEntry: "dist/windows-helper.js",
    claimObserved: Boolean(claim?.result),
    cases,
  };
  const outArg = process.argv.indexOf("--out");
  const out =
    outArg > 0 ? process.argv[outArg + 1] : join(here, "fixtures", "official-helper-win32.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  console.log(`recorded ${cases.length} cases -> ${out}`);
  for (const c of cases) {
    const ok = c.response?.ok === true;
    const code = c.response?.error?.code;
    console.log(`  ${ok ? "ok  " : `err(${code ?? "?"})`} ${c.name}`);
  }
}
await main();
