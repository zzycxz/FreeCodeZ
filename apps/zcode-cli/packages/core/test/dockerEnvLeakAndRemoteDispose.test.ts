// 0C-4①（V10）：`docker inspect -f '{{.Config.Env}}'` 经只读白名单零审批泄露容器密钥
// ——format 模板引用 .Config.Env 即判危险（json/纯文本/range 变体全覆盖）。
// 0C-4③：RemoteAgentConnection dispose 后的迟到 close 不得重连（rpc 包，源级锚定——
// 该模块当前无消费者，行为级测试在 rpc 侧装配成本不成比例）。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dockerCommandIsDangerous } from "../src/tool/handlers/bash-readonly-policy-callbacks.js";

const here = dirname(fileURLToPath(import.meta.url));

test("V10：format 模板引用 .Config.Env 判危险（三种形态）", () => {
  assert.equal(dockerCommandIsDangerous("docker inspect -f {{.Config.Env}} c1", ["-f", "{{.Config.Env}}", "c1"]), true);
  assert.equal(dockerCommandIsDangerous("docker inspect --format {{json .Config.Env}} c1", ["--format", "{{json .Config.Env}}", "c1"]), true);
  assert.equal(dockerCommandIsDangerous("docker inspect -f={{range .Config.Env}}{{.}}{{end}} c1", ["-f={{range .Config.Env}}{{.}}{{end}}", "c1"]), true);
});

test("V10：常规 inspect format 零误伤", () => {
  assert.equal(dockerCommandIsDangerous("docker inspect -f {{.State.Status}} c1", ["-f", "{{.State.Status}}", "c1"]), false);
  assert.equal(dockerCommandIsDangerous("docker inspect c1", ["c1"]), false);
  assert.equal(dockerCommandIsDangerous("docker inspect --format {{.Id}} c1", ["--format", "{{.Id}}", "c1"]), false);
});

test("锚定：rpc dispose 后重连守卫在场（0C-4③ 回归锚）", () => {
  const source = readFileSync(
    join(here, "../../../../../packages/rpc/src/remote.ts"),
    "utf8",
  );
  assert.match(source, /if \(this\.disposed\) return;/, "迟到 close 不得触发重连");
  assert.match(
    source,
    /throw new Error\("RemoteAgentConnection is disposed; reconnect is not allowed\."\)/,
    "dispose 后显式 reconnect 必须抛错",
  );
});
