// 条目1（升级实施手册）：ZCODE_*→FREECODEZ_* 命名空间迁移的兼容性测试。
// ① 路径/凭证型双读：FREECODEZ_DATA_BASE_DIR 优先，ZCODE_DATA_BASE_DIR 回退（quartet L04 模板）；
// ② 迁移 warn：外来 ZCODE_* 提示一次、桥接白名单不告警、抑制开关可用；
// ③ server-cli 数据根同款双读（源级锚定——resolveServerLayout 依赖进程 env，结构锚更稳）。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { warnLegacyZCodeEnvKeys, MIGRATION_BRIDGED_ZCODE_KEYS } from "../src/runtimeEnv.js";

const here = dirname(fileURLToPath(import.meta.url));

function withEnv(env: Record<string, string | undefined>, run: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of [...Object.keys(env), "FREECODEZ_DATA_BASE_DIR", "ZCODE_DATA_BASE_DIR"]) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("双读：FREECODEZ_DATA_BASE_DIR 优先于旧键（services getDataBaseDir 模块级缓存）", () => {
  // getDataBaseDir 有模块级缓存（_dataBaseDir），env 断言走源码锚 + warn 侧真实执行。
  const source = readFileSync(join(here, "../../services/src/paths.ts"), "utf8");
  const match = /process\.env\.FREECODEZ_DATA_BASE_DIR\?\.trim\(\) \|\| process\.env\.ZCODE_DATA_BASE_DIR\?\.trim\(\)/.exec(source);
  assert.ok(match, "services 数据根必须新键优先、旧键回退（0x1 双读模板）");
});

test("双读：server-cli 数据根同款（源级锚定）", () => {
  const source = readFileSync(
    join(here, "../../zcode-server-cli/src/runtime/paths.ts"),
    "utf8",
  );
  const match = /process\.env\.FREECODEZ_DATA_BASE_DIR\?\.trim\(\) \|\| process\.env\.ZCODE_DATA_BASE_DIR\?\.trim\(\)/.exec(source);
  assert.ok(match, "server-cli 数据根必须同款双读");
});

test("双读：desktop 写侧双写（新键 + 桥接旧键）", () => {
  const source = readFileSync(
    join(here, "../../desktop/src/main/desktopRuntimeEnv.ts"),
    "utf8",
  );
  const match = /FREECODEZ_DATA_BASE_DIR: dataBaseDir, ZCODE_DATA_BASE_DIR: dataBaseDir/.exec(source);
  assert.ok(match, "desktop 注入链必须双写：新键为主 + 旧键桥接（仓外插件按旧名读）");
});

test("迁移 warn：外来 ZCODE_* 打一条 console.warn，桥接白名单不告警", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: unknown) => {
    warnings.push(String(message));
  };
  try {
    withEnv(
      {
        ZCODE_TOTALLY_FOREIGN: "1",
        ZCODE_DATA_BASE_DIR: "/legacy/bridge", // 在白名单
      },
      () => {
        warnLegacyZCodeEnvKeys(process.env);
        // 同键第二次不再打（去重）。
        warnLegacyZCodeEnvKeys(process.env);
      },
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(
    warnings.filter((message) => message.includes("ZCODE_TOTALLY_FOREIGN")).length,
    1,
    "外来键恰好一条 warn（去重）",
  );
  assert.equal(
    warnings.filter((message) => message.includes("ZCODE_DATA_BASE_DIR")).length,
    0,
    "桥接白名单键不告警",
  );
  assert.ok(MIGRATION_BRIDGED_ZCODE_KEYS.has("ZCODE_DATA_BASE_DIR"));
});

test("迁移 warn：FREECODEZ_DISABLE_MIGRATION_WARN=1 全静默", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: unknown) => {
    warnings.push(String(message));
  };
  try {
    withEnv(
      {
        FREECODEZ_DISABLE_MIGRATION_WARN: "1",
        ZCODE_ANOTHER_FOREIGN: "1",
      },
      () => {
        warnLegacyZCodeEnvKeys(process.env);
      },
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 0, "抑制开关必须全静默");
});

test("FREECODEZ_* 新键不触发迁移 warn（方向正确性）", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: unknown) => {
    warnings.push(String(message));
  };
  try {
    withEnv({ FREECODEZ_DATA_BASE_DIR: "/new/key" }, () => {
      warnLegacyZCodeEnvKeys(process.env);
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 0, "新命名空间是目标态，不得告警");
});
