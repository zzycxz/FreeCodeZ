// 0-6 修复测试（升级实施手册）：daemon /ws 零鉴权 + capability 发放口不设门。
// 语义与 lite server P2 §4.11 对齐：设置 token（ZCODE_SERVER_TOKEN / options.authToken）后
// /ws 与 /api/rpc-host-capability 需要 token（Bearer 头或 ?token=）；未设置时回环保持现状。
// /ws/host 的 capability 门为既有行为，不因 token 配置与否改变。
import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest } from "node:http";
import type { ServiceCollection } from "@zcode/rpc";
import { createCoreHttpServer } from "../src/server-core/http.js";

/** 原始 WS 升级探测：fetch 会剥 Upgrade/Connection 头，必须用 node:http 控制完整头。 */
function wsUpgradeStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path, headers: { connection: "Upgrade", upgrade: "websocket" } },
      (response) => resolve(response.statusCode ?? 0),
    );
    request.on("error", reject);
    request.end();
  });
}

function getStatus(port: number, path: string, init?: RequestInit): Promise<number> {
  return fetch(`http://127.0.0.1:${port}${path}`, init).then((response) => response.status);
}

async function withServer(
  options: Parameters<typeof createCoreHttpServer>[1],
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = await createCoreHttpServer({} as ServiceCollection, options);
  try {
    await run(server.port);
  } finally {
    await server.close();
  }
}

test("无 token：回环现状保持（authRequired=false，发放口可用）", async () => {
  await withServer({}, async (port) => {
    const info = await (await fetch(`http://127.0.0.1:${port}/api/server-info`)).json();
    assert.equal(info.authRequired, false);
    const issued = await fetch(`http://127.0.0.1:${port}/api/rpc-host-capability`, {
      method: "POST",
    });
    assert.equal(issued.status, 200);
  });
});

test("设置 token：/ws 无 token 拒、带 token 过守卫", async () => {
  await withServer({ authToken: "secret-token-1" }, async (port) => {
    assert.equal(await wsUpgradeStatus(port, "/ws"), 401, "无 token 的 WS 升级必须被拒");
    assert.equal(await wsUpgradeStatus(port, "/ws?token=wrong"), 401, "错 token 必须被拒");
    // 带 token 过守卫：完整升级握手头下不再是 401（101/400 均证明已进入升级链）。
    const withTokenStatus = await wsUpgradeStatus(port, "/ws?token=secret-token-1");
    assert.notEqual(withTokenStatus, 401);
  });
});

test("设置 token：capability 发放口同守卫（Bearer/查询参数）", async () => {
  await withServer({ authToken: "secret-token-2" }, async (port) => {
    assert.equal(
      await getStatus(port, "/api/rpc-host-capability", { method: "POST" }),
      401,
    );
    const bearer = await fetch(`http://127.0.0.1:${port}/api/rpc-host-capability`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token-2" },
    });
    assert.equal(bearer.status, 200);
    assert.ok((await bearer.json()).capability, "带 token 发放 capability 正常");
    assert.equal(
      await getStatus(port, "/api/rpc-host-capability?token=secret-token-2", { method: "POST" }),
      200,
    );
  });
});

test("server-info 始终公开且如实反映 authRequired", async () => {
  await withServer({ authToken: "secret-token-3" }, async (port) => {
    const info = await (await fetch(`http://127.0.0.1:${port}/api/server-info`)).json();
    assert.equal(info.authRequired, true);
  });
});
