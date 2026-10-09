// W-32 升级路径测试：计划纯函数五面（安装树/socket/TCC/插件缓存/环境）+ 执行幂等。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  planLegacyComputerUseMigration,
  runLegacyComputerUseMigration,
} from "../src/main/legacyComputerUseMigration.js";

describe("W-32 迁移计划（纯）", () => {
  it("darwin：安装树+socket 目录+TCC 双行+插件缓存+环境提示", () => {
    const actions = planLegacyComputerUseMigration({
      platform: "darwin",
      homedir: "/Users/u",
      tmpdir: "/tmp",
      uid: "501",
      env: { ZCODE_CUA_PERMISSION_BROKER_SOCKET: "x", PATH: "/usr/bin" },
      pluginCacheRoots: ["/Users/u/.freecodez/cli/plugins"],
    });
    const kinds = actions.map((a) => `${a.kind}:${a.label}`);
    assert.ok(kinds.some((k) => k === "remove-dir:legacy helper install tree"));
    assert.ok(kinds.some((k) => k.includes("legacy broker socket dir")));
    assert.strictEqual(
      actions.filter((a) => a.kind === "tccutil-reset").map((a) => a.service).join(","),
      "Accessibility,ScreenCapture",
    );
    assert.ok(kinds.some((k) => k.includes("legacy plugin cache entries")));
    const warn = actions.find((a) => a.kind === "warn-env");
    assert.deepStrictEqual(warn?.keys, ["ZCODE_CUA_PERMISSION_BROKER_SOCKET"]);
  });

  it("win32：无 socket 目录删除（管道随进程亡），无 TCC 动作", () => {
    const actions = planLegacyComputerUseMigration({
      platform: "win32",
      homedir: "C:\\Users\\u",
      tmpdir: "C:\\Temp",
      uid: "0",
      env: {},
      pluginCacheRoots: [],
    });
    assert.ok(!actions.some((a) => a.kind === "remove-dir" && a.label.includes("socket")));
    assert.ok(!actions.some((a) => a.kind === "tccutil-reset"));
  });
});

describe("W-32 执行器（幂等）", () => {
  it("remove-dir：在场即删、缺席跳过；重复执行零副作用", () => {
    const root = mkdtempSync(join(tmpdir(), "fc-migrate-"));
    const target = join(root, "computer-use");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "identity.json"), "{}");
    const actions = [
      { kind: "remove-dir", path: target, label: "test tree" },
      { kind: "remove-dir", path: join(root, "absent"), label: "absent tree" },
    ];
    const first = runLegacyComputerUseMigration(actions);
    assert.strictEqual(first[0]?.result, "removed");
    assert.strictEqual(first[1]?.result, "absent");
    assert.ok(!existsSync(target));
    const second = runLegacyComputerUseMigration(actions);
    assert.strictEqual(second[0]?.result, "absent", "幂等：重复执行即缺席");
  });
});
