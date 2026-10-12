#!/usr/bin/env node
// FreeCodeZ A4 三平台冒烟脚本：fork sidecar → capabilities/listApps/getAppState/click
// 逐项返回结构化信封。在目标平台真机上运行（macOS/Linux/Windows 各跑一次）。
// 用法：node --import tsx scripts/platform-smoke.mjs [--sidecar <path>] [--helper <path>] [--actions]
// 输出：逐方法 ok/error + 平台 supports 真值摘要 + A4 判定。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv;
const sidecarFlag = args.indexOf("--sidecar");
const helperFlag = args.indexOf("--helper");
// V1.19 P6：--actions 追加动作面验收段（TextEdit 一站式：setValue/hotkey/typeText/
// pressKey/pasteText/scroll + 终树验证；需 TCC 已授）。
const actionsFlag = args.indexOf("--actions") >= 0;

const sidecarPath = sidecarFlag >= 0
  ? args[sidecarFlag + 1]
  : join(pkgRoot, "dist", "computer-sidecar.js");

const platform = process.platform;
const results = { platform, methods: [], capabilities: null, verdict: "PASS" };

function record(method, response) {
  const entry = {
    method,
    ok: response.ok === true,
    code: response.ok ? undefined : response.error?.code,
    message: response.ok ? undefined : (response.error?.message ?? "").slice(0, 120),
  };
  results.methods.push(entry);
  if (!entry.ok && entry.code !== "permission_denied") {
    // permission_denied 是 TCC 未授的预期形态（不算 fail），其他 error 记 FAIL。
    results.verdict = "FAIL";
  }
}

async function main() {
  // 构建 sidecar（在目标平台上构建产物一致——纯 Node 无原生依赖）。
  execFileSync(process.execPath, [join(pkgRoot, "scripts", "build-sidecar.mjs")], {
    cwd: pkgRoot,
    stdio: "pipe",
  });
  if (!existsSync(sidecarPath)) {
    console.error(`[platform-smoke] sidecar missing: ${sidecarPath}`);
    process.exit(1);
  }

  const { ComputerSidecarHarness } = await import(join(pkgRoot, "src", "host", "sidecar-harness.ts"));
  const env = {};
  // W-11 红线：helper peer 信任要求 sidecar 跑在可信 app 身份下——mac 上优先用
  // 打包好的 FreeCodeZ 应用二进制（ELECTRON_RUN_AS_NODE），与金样录制同款。
  let execPath;
  const appExecutable = join(
    pkgRoot, "..", "desktop", "dist", "mac-arm64", "FreeCodeZ.app", "Contents", "MacOS", "FreeCodeZ",
  );
  if (platform === "darwin" && existsSync(appExecutable)) {
    env.ELECTRON_RUN_AS_NODE = "1";
    execPath = appExecutable;
  }
  // macOS：helper 路径（打包态由主进程注入；冒烟手动传或用默认 .build 路径）。
  if (platform === "darwin") {
    const helperAppPath = helperFlag >= 0
      ? args[helperFlag + 1]
      : join(pkgRoot, "native", "computer-use-macos", ".build", "release", "FreeCodeZ Computer Use.app");
    if (existsSync(helperAppPath)) {
      env.FREECODEZ_COMPUTER_MACOS_HELPER_APP_PATH = helperAppPath;
    }
  }
  const harness = new ComputerSidecarHarness({ sidecarPath, env, ...(execPath ? { execPath } : {}) });

  try {
    // 1. capabilities（A4 核心：三平台各自的 supports 真值）。
    const caps = await harness.request("capabilities");
    record("capabilities", caps);
    if (caps.ok) {
      results.capabilities = caps.result.supports;
    }

    // 2. listApps（macOS NSWorkspace / win UIA / linux AT-SPI）。
    record("listApps", await harness.request("listApps"));

    // 3. listWindows（macAX / win 仅主窗 / linux AT-SPI）。
    const apps = results.methods.find((m) => m.method === "listApps" && m.ok);
    if (apps) {
      record("listWindows", await harness.request("listWindows", { app: "com.apple.finder" }));
    }

    // 4. getAppState（AX/UIA/AT-SPI 读树——TCC 未授时预期 permission_denied）。
    record("getAppState", await harness.request("getAppState", {
      app: "com.apple.finder",
      noScreenshot: true,
    }));

    // 5. click（动作面——TCC 未授时预期 permission_denied）。
    record("click", await harness.request("click", {
      app: "com.apple.finder",
      elementIndex: 0,
    }));

    // ---- V1.19 P6：动作面验收 harness（--actions）----
    // 背景：引擎 13 方法中 8 个动作方法从未真机执行（A4 只冒烟了 5 个观测+click）。
    // 本段用 TextEdit 一站式覆盖 setValue/hotkey/typeText/pressKey/pasteText/scroll
    //（performSecondaryAction/drag 留金样与专项用例）。需要 TCC 已授（否则各步
    // permission_denied 如实记录）。win/linux VM 冒烟时换对应应用与启动命令。
    if (actionsFlag) {
      const act = (method, response) => {
        const entry = {
          method,
          ok: response.ok === true,
          code: response.ok ? undefined : response.error?.code,
        };
        results.methods.push(entry);
        if (!entry.ok && entry.code !== "permission_denied") results.verdict = "FAIL";
        return response;
      };
      execFileSync("open", ["-a", "TextEdit"]);
      await new Promise((r) => setTimeout(r, 2500));
      const st = act("actions.getAppState", await harness.request("getAppState", {
        app: "TextEdit",
        noScreenshot: true,
      }));
      const tree = st.ok ? st.result?.snapshot?.treeText ?? "" : "";
      const areaLine = tree
        .split("\n")
        .find((line) => /text( entry)? area|AXTextArea/i.test(line) && !/placeholder/i.test(line));
      const areaIndex = areaLine?.match(/\[(\d+)\]/)?.[1] ?? areaLine?.match(/^\s*(\d+)\s/)?.[1];
      if (areaIndex === undefined) {
        results.methods.push({
          method: "actions.harness",
          ok: false,
          code: "text_area_not_found",
          message: areaLine?.slice(0, 120),
        });
        results.verdict = "FAIL";
      } else {
        const idx = Number(areaIndex);
        act("setValue", await harness.request("setValue", { app: "TextEdit", elementIndex: idx, value: "smoke" }));
        act("hotkey", await harness.request("hotkey", { app: "TextEdit", key: "CmdOrCtrl+A" }));
        act("typeText", await harness.request("typeText", { app: "TextEdit", text: "V1.19" }));
        act("pressKey", await harness.request("pressKey", { app: "TextEdit", key: "Return" }));
        act("pasteText", await harness.request("pasteText", { app: "TextEdit", text: "pasted" }));
        act("scroll", await harness.request("scroll", {
          app: "TextEdit", elementIndex: idx, direction: "down", amount: 30,
        }));
        const final = await harness.request("getAppState", { app: "TextEdit", noScreenshot: true });
        const finalTree = final.ok ? final.result?.snapshot?.treeText ?? "" : "";
        const verified = finalTree.includes("V1.19") && finalTree.includes("pasted");
        results.methods.push({
          method: "actions.verify",
          ok: verified,
          code: verified ? undefined : "final_tree_missing_expected_text",
        });
        if (!verified) results.verdict = "FAIL";
      }
    }
  } finally {
    await harness.stop();
  }

  console.log(JSON.stringify(results, null, 2));
  console.log(`\n[platform-smoke] ${platform}: ${results.verdict}`);
  process.exit(results.verdict === "PASS" ? 0 : 1);
}

void main();
