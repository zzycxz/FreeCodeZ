// U3-0（移植自 ZCode 3.15.1）plugin-sandbox 基座纯件测试：
// provenance refine（mcp-app 必带身份 / gen-ui 可省）、身份与分区派生、URL 构造与
// 解析往返、origin 白名单、CSP 形状、配额、registry 查询、shell 文档安全属性。
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPluginSandboxContentCsp,
  isAllowedPluginSandboxOrigin,
  parsePluginSandboxUrl,
  PLUGIN_SANDBOX_MAX_INSTANCES,
  PLUGIN_SANDBOX_SCHEME,
  pluginSandboxAppIdentity,
  pluginSandboxPartitionFor,
  pluginSandboxRegisterRequestSchema,
  pluginSandboxShellUrl,
} from "@zcode/shared";
import {
  buildShellDocument,
  createPluginSandboxGateway,
  PluginSandboxQuotaError,
} from "../src/main/pluginSandboxProtocol.js";

test("provenance refine：mcp-app 必带 pluginId/serverName/origin；gen-ui 可省", () => {
  assert.equal(
    pluginSandboxRegisterRequestSchema.safeParse({ contentKind: "mcp-app" }).success,
    false,
  );
  assert.equal(
    pluginSandboxRegisterRequestSchema.safeParse({
      contentKind: "mcp-app",
      pluginId: "acme",
      serverName: "acme-server",
      origin: "https://ui.acme.dev",
    }).success,
    true,
  );
  assert.equal(
    pluginSandboxRegisterRequestSchema.safeParse({ contentKind: "gen-ui" }).success,
    true,
  );
});

test("身份/分区/URL 派生：同身份稳定，跨身份隔离", () => {
  const request = {
    contentKind: "mcp-app",
    pluginId: "acme",
    serverName: "acme-server",
    origin: "https://ui.acme.dev",
  } as const;
  const identity = pluginSandboxAppIdentity(request);
  assert.equal(identity, "mcp-app:acme@acme-server");
  assert.equal(pluginSandboxAppIdentity({ ...request }), identity);
  // 纯 JS 双轮 FNV 摘要：32 hex（preload 白名单防线禁 node:crypto，见 shared 模块注释）。
  assert.match(pluginSandboxPartitionFor(identity), /^persist:plugin-sandbox-v2-[0-9a-f]{32}$/);

  const shellUrl = pluginSandboxShellUrl(identity, "sb-1");
  const parts = parsePluginSandboxUrl(shellUrl);
  assert.equal(parts?.role, "shell");
  assert.equal(parts?.sandboxId, "sb-1");
  const contentUrl = `${PLUGIN_SANDBOX_SCHEME}://plugin-${
    shellUrl.includes("shell-") ? parsePluginSandboxUrl(shellUrl)?.appIdentityHash : ""
  }/instance/sb-1/index.html`;
  const contentParts = parsePluginSandboxUrl(contentUrl);
  assert.equal(contentParts?.role, "plugin");
  assert.equal(contentParts?.contentPath, "/index.html");
  assert.equal(parsePluginSandboxUrl("https://evil.example"), undefined);
});

test("origin 白名单：https/wss/127.0.0.1 放行，其余拒绝", () => {
  assert.equal(isAllowedPluginSandboxOrigin("https://ui.acme.dev"), true);
  assert.equal(isAllowedPluginSandboxOrigin("http://127.0.0.1:3927"), true);
  assert.equal(isAllowedPluginSandboxOrigin("http://localhost:3927"), false);
  assert.equal(isAllowedPluginSandboxOrigin("file:///etc/passwd"), false);
});

test("CSP 形状：connect-src none / form-action none / frame-src 自协议", () => {
  const csp = buildPluginSandboxContentCsp();
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, new RegExp(`frame-src ${PLUGIN_SANDBOX_SCHEME}:`));
});

test("网关：注册/开实例/配额/registry 查询", () => {
  const gateway = createPluginSandboxGateway({
    protocol: { handle: () => () => {} } as unknown as Parameters<typeof createPluginSandboxGateway>[0]["protocol"],
    logger: { warn: () => {} },
    fetchImpl: async () => new Response("ok", { headers: { "content-type": "text/html" } }),
  });
  const registration = gateway.registerApp({
    contentKind: "mcp-app",
    pluginId: "acme",
    serverName: "acme-server",
    origin: "https://ui.acme.dev",
    permissions: ["clipboard-write"],
  });
  gateway.install();
  const instance = gateway.openInstance(registration.appIdentity);
  assert.equal(gateway.isRegisteredSandboxSrc(instance.shellUrl), true);
  assert.equal(gateway.isRegisteredSandboxSrc("https://not-sandbox.example"), false);
  // 未注册来源的 sandbox URL 不算合法 src
  assert.equal(
    gateway.isRegisteredSandboxSrc(
      `${PLUGIN_SANDBOX_SCHEME}://plugin-deadbeef/instance/x/`,
    ),
    false,
  );
  // 配额：开满即抛 QuotaError
  const opened = [instance];
  for (let i = 1; i < PLUGIN_SANDBOX_MAX_INSTANCES; i += 1) {
    opened.push(gateway.openInstance(registration.appIdentity));
  }
  assert.throws(() => gateway.openInstance(registration.appIdentity), PluginSandboxQuotaError);
  gateway.closeInstance(opened[0]?.sandboxId ?? "");
  assert.equal(gateway.openInstance(registration.appIdentity).sandboxId.length > 0, true);
});

test("shell 文档：内层 iframe 带 sandbox/allow/no-referrer，src 指向重发布 URL", () => {
  const document = buildShellDocument({
    pluginSrc: `${PLUGIN_SANDBOX_SCHEME}://plugin-abc/instance/sb-9/index.html`,
    iframeAllow: "clipboard-write",
    initJson: '{"sandboxId":"sb-9"}',
  });
  assert.match(document, /sandbox="allow-scripts allow-same-origin allow-forms"/);
  assert.match(document, /allow="clipboard-write"/);
  assert.match(document, /referrerpolicy="no-referrer"/);
  assert.match(document, /plugin-abc\/instance\/sb-9\/index\.html/);
});
