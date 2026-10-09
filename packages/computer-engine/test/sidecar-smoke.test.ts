// FreeCodeZ A3 冒烟（非 orca 原件，W-10）：fork 独立 sidecar 产物后
// capabilities/listApps/getAppState/click 逐项返回。无 helper/provider 的环境
// （W-11 helper 产线未落地前）每项应返回结构化 unsupported_capability 错误信封；
// provider 就位后同用例自动变为 ok:true 结果断言的演进面（W-22 细化）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ComputerSidecarHarness, type SidecarResponse } from "../src/host/sidecar-harness";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sidecarPath = join(pkgRoot, "dist", "computer-sidecar.js");

function buildSidecar(): void {
  execFileSync(process.execPath, [join(pkgRoot, "scripts", "build-sidecar.mjs")], {
    cwd: pkgRoot,
    stdio: "pipe",
  });
}

function assertStructuredResponse(response: SidecarResponse, id: number, method: string): void {
  assert.strictEqual(response.id, id, `${method} 响应 id 回显`);
  if (response.ok) {
    assert.ok(response.result !== undefined, `${method} ok 响应须携带 result`);
    return;
  }
  assert.strictEqual(typeof response.error?.message, "string", `${method} 错误信封须有 message`);
  assert.ok(response.error?.code, `${method} 错误信封须有 code`);
}

describe("computer sidecar smoke (A3)", () => {
  it("fork 独立产物后 capabilities/listApps/getAppState/click 逐项返回", async () => {
    buildSidecar();
    assert.ok(existsSync(sidecarPath), "sidecar 产物必须在场");
    const harness = new ComputerSidecarHarness({ sidecarPath });
    try {
      const methods: Array<[string, Record<string, unknown> | undefined]> = [
        ["capabilities", undefined],
        ["listApps", undefined],
        ["getAppState", { app_ref: { pid: 1 } }],
        ["click", { app_ref: { pid: 1 }, x: 1, y: 1 }],
      ];
      let id = 1;
      for (const [method, params] of methods) {
        const response = await harness.request(method, params);
        assertStructuredResponse(response, id, method);
        id += 1;
      }
      assert.deepStrictEqual(harness.errors, [], `sidecar stderr 应干净：${harness.errors.join("")}`);
    } finally {
      await harness.stop();
    }
  });
});
