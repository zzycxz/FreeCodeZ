// FreeCodeZ W-22 回放门禁：金样样本对照当前 sidecar wire（期望值=新引擎自有点位录制，
// R4 禁止官方实录作期望值）。无 TCC 环境下 error 形样本同样受门禁——错误信封也是契约。
// 覆盖面对齐 W-00③ 场景清单（36 例映射 + W-22 增补）；needsTcc 场景待 A10 授权后
// 重录为成功面（record-golden.mjs --only <id>）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ComputerSidecarHarness } from "../../src/host/sidecar-harness.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const samplesDir = join(pkgRoot, "test", "golden", "samples");


/**
 * 规范化：wire 契约比对的稳健口径——
 * ①对象键序递归排序（Swift 字典编码键序非定）；②id 回显归零；
 * ③pid 归零 + 应用数组按 bundleId/name 排序（进程号与枚举序属时变量，非契约）。
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map((item) => canonicalize(item));
    const isAppList = mapped.every(
      (item) => item !== null && typeof item === "object" && ("bundleId" in item || "pid" in item),
    );
    return isAppList
      ? [...mapped].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        )
      : mapped;
  }
  if (typeof value === "string") {
    // 时变量掩码：等待毫秒/秒数等运行期数值不属 wire 契约。
    return value.replace(/\d+/g, "<n>");
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = key === "id" || key === "pid" ? 0 : canonicalize(record[key]);
    }
    return out;
  }
  return value;
}

describe("golden 回放门禁（W-22）", () => {
  const SAFE_METHODS = new Set(["capabilities", "listApps", "listWindows", "getAppState"]);
  const files = readdirSync(samplesDir).filter((name) => name.endsWith(".json")).sort();

  it("金样覆盖面对齐场景清单（≥20 样本在档）", () => {
    assert.ok(files.length >= 20, `金样样本不足：${files.length}`);
  });

  it("契约形状校验（全部样本：信封/错误码词表/成功面必备键）", () => {
    const codeVocabulary = new Set([
      "invalid_argument",
      "app_not_found",
      "permission_denied",
      "element_not_found",
      "window_not_found",
      "window_not_focused",
      "value_not_settable",
      "action_not_supported",
      "unsupported_capability",
      "accessibility_error",
      "screenshot_failed",
      "action_timeout",
      "provider_incompatible",
    ]);
    for (const file of files) {
      const sample = JSON.parse(readFileSync(join(samplesDir, file), "utf8"));
      const response = sample.response as {
        id: unknown;
        ok?: boolean;
        result?: unknown;
        error?: { code?: unknown; message?: unknown };
      };
      assert.strictEqual(typeof response.id, "number", `${sample.scenario}: id 回显`);
      if (response.ok === true) {
        assert.ok(response.result !== undefined, `${sample.scenario}: ok 面必带 result`);
      } else {
        assert.ok(response.error?.message, `${sample.scenario}: 错误面必带 message`);
        assert.ok(
          codeVocabulary.has(String(response.error?.code)),
          `${sample.scenario}: 错误码出词表 ${String(response.error?.code)}`,
        );
      }
    }
  });

  it("确定性场景 wire 级回放一致（capabilities + 全部 error 形态）", async () => {
    execFileSync(process.execPath, [join(pkgRoot, "scripts", "build-sidecar.mjs")], {
      cwd: pkgRoot,
      stdio: "pipe",
    });
    const helperAppPath = join(
      pkgRoot,
      "native",
      "computer-use-macos",
      ".build",
      "release",
      "FreeCodeZ Computer Use.app",
    );
    // 与录制上下文一致：peer 信任面要求 sidecar 跑在可信 app 身份下（W-11 红线）。
    const appExecutable = join(
      pkgRoot,
      "..",
      "desktop",
      "dist",
      "mac-arm64",
      "FreeCodeZ.app",
      "Contents",
      "MacOS",
      "FreeCodeZ",
    );
    const useAppIdentity = existsSync(appExecutable);
    const harness = new ComputerSidecarHarness({
      sidecarPath: join(pkgRoot, "dist", "computer-sidecar.js"),
      env: {
        FREECODEZ_COMPUTER_MACOS_HELPER_APP_PATH: helperAppPath,
        ...(useAppIdentity ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
      ...(useAppIdentity ? { execPath: appExecutable } : {}),
    });
    try {
      for (const file of files) {
        const sample = JSON.parse(readFileSync(join(samplesDir, file), "utf8"));
        if (!SAFE_METHODS.has(sample.method)) continue;
        // 确定性口径：capabilities 全量比对；listApps/listWindows/getAppState 的
        // ok 形态嵌活桌面状态（应用集/窗口集随开关变化）不进 wire 级重放——
        // 由上一用例的契约形状校验覆盖（信封+必备键）。error 形态信封确定，全量比对。
        const isErrorForm = sample.response.ok !== true;
        if (sample.method !== "capabilities" && !isErrorForm) continue;
        const response = await harness.request(sample.method, sample.params);
        assert.deepStrictEqual(
          canonicalize(response),
          canonicalize(sample.response),
          `golden 回放漂移：${sample.scenario}（如有意变更，重录：record-golden.mjs --only ${sample.scenario}）`,
        );
      }
    } finally {
      await harness.stop();
    }
  });

  it("动作场景不由回放门禁执行（防真机副作用；语义由 SDK/会话层单测族覆盖）", () => {
    const actionSamples = files.filter((file) => {
      const sample = JSON.parse(readFileSync(join(samplesDir, file), "utf8"));
      return !SAFE_METHODS.has(sample.method);
    });
    // 动作样本仅做契约形状校验（上一用例），此处断言分流确实发生过。
    assert.ok(actionSamples.length > 0);
  });
});
