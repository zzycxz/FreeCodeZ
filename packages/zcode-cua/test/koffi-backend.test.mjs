// Phase 1（升级实施手册）：koffi 进程内执行层测试。
// darwin 真机段验证端到端 AX 读取（与打包后的手工验收互补）；
// 非 darwin 段验证 fail-closed（三道保险之一：绑定不可用 → 工厂返回 null）。
import assert from "node:assert/strict";
import test from "node:test";
import { createKoffiBrokerMethods } from "../macos/index.js";
import { loadKoffiBindings, withCFString } from "../macos/koffi-ax.js";
import { parseLsappinfoList } from "../macos/ax-observation.js";
import { parseKeyChord } from "../macos/ax-actions.js";
// P1-f 表面分类/生命周期纯件（真机证据：TextEdit ⌘S 保存面板=AXSheet 且 subrole 空，
// 子树按钮 保存/取消 + 文本框「保存为：」——区分只能靠内容特征）。
import { sheetPanelKindFromButtons, surfaceLifecycleFromDiff } from "../macos/koffi-tree.js";
import { loadAppInstruction } from "../macos/koffi-tree.js";

const IS_DARWIN = process.platform === "darwin";

test("非 darwin：绑定与工厂 fail-closed（返回 null，不抛）", { skip: IS_DARWIN }, () => {
  assert.equal(loadKoffiBindings(), null);
  assert.equal(createKoffiBrokerMethods({ allowActions: true }), null);
});

test("lsappinfo 输出解析：Foreground/UIElement 收录、BackgroundOnly 剔除", () => {
  const sample = [
    ' 1) "loginwindow" ASN:0x0-0x3003: ',
    '    bundleID="com.apple.loginwindow"',
    '    pid = 482 type="UIElement" flavor=3',
    ' 2) "universalaccessd" ASN:0x0-0x8008: ',
    '    bundleID=[ NULL ] ',
    '    pid = 688 type="BackgroundOnly"',
    ' 3) "Finder" ASN:0x0-0x9009: ',
    '    bundleID="com.apple.finder"',
    '    pid = 512 type="Foreground"',
  ].join("\n");
  const apps = parseLsappinfoList(sample);
  assert.deepEqual(
    apps.map((app) => app.bundleId),
    ["com.apple.loginwindow", "com.apple.finder"],
    "BackgroundOnly 与无 bundleId 的条目剔除",
  );
  assert.equal(apps[1]?.pid, 512);
});

test("键序解析：修饰符组合/未知名拒绝", () => {
  assert.deepEqual(parseKeyChord("cmd+shift+t"), { keycode: 17, flags: 1179648 });
  assert.deepEqual(parseKeyChord("return"), { keycode: 36, flags: 0 });
  assert.equal(parseKeyChord("bogus-key"), undefined);
  assert.equal(parseKeyChord(""), undefined);
});

// ── darwin 真机段（koffi 已在依赖树；无 TCC 时功能断言降级为形状断言）──

test("darwin：工厂产出诊断/观测面，动作面默认关（三道保险之二）", { skip: !IS_DARWIN }, () => {
  const backend = createKoffiBrokerMethods({ allowActions: false });
  assert.ok(backend, "koffi 在 darwin + 依赖树内必须可用（koffi 是 node_modules 直接依赖）");
  const names = Object.keys(backend.methods);
  for (const expected of ["broker_info", "permission_status", "list_applications", "capture_app", "list_windows"]) {
    assert.ok(names.includes(expected), `观测面缺方法 ${expected}`);
  }
  for (const banned of ["click", "scroll", "press_key", "type_text", "paste", "drag"]) {
    assert.ok(!names.includes(banned), `动作方法 ${banned} 在 allowActions=false 时不得暴露`);
  }
  backend.dispose();
});

test("darwin：诊断方法返回结构化状态（capabilities 反映阶段开关）", { skip: !IS_DARWIN }, async () => {
  const backend = createKoffiBrokerMethods({ allowActions: false });
  const info = await backend.methods.broker_info({});
  assert.equal(info.ok, true);
  assert.equal(info.backend, "koffi-in-process");
  assert.equal(info.capabilities.ax_observation, true);
  assert.equal(info.capabilities.synthetic_input, false, "只读阶段 synthetic_input 必须为 false");
  const perm = await backend.methods.permission_status({});
  assert.equal(perm.ok, true);
  assert.equal(typeof perm.accessibility, "boolean");
  backend.dispose();
});

test("darwin：list_applications 返回带 pid/bundleId 的清单", { skip: !IS_DARWIN }, async () => {
  const backend = createKoffiBrokerMethods({ allowActions: false });
  const result = await backend.methods.list_applications({});
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.apps));
  assert.ok(result.apps.length > 0, "GUI 应用清单不应为空");
  for (const app of result.apps.slice(0, 5)) {
    assert.ok(Number.isInteger(app.pid));
    assert.equal(typeof app.bundleId, "string");
  }
  backend.dispose();
  process.exitCode = undefined;
});

test("darwin：capture_app 返回扁平元素树 + native 句柄跨方法可用", { skip: !IS_DARWIN }, async () => {
  const backend = createKoffiBrokerMethods({ allowActions: false });
  // Finder 常驻且 AX 实现原生，是稳定观测样本。
  const capture = await backend.methods.capture_app({ app_ref: "com.apple.finder" });
  assert.equal(capture.ok, true, `capture_app 失败: ${JSON.stringify(capture.error ?? {})}`);
  assert.ok(Array.isArray(capture.elements) && capture.elements.length > 0);
  const root = capture.elements[0];
  assert.equal(root.role, "AXApplication");
  assert.equal(root.depth, 0);
  assert.equal(root.owner_pid > 0, true);
  assert.equal(typeof root.native, "string");
  // 句柄跨方法：read_element 按 native 找回（窗口 bounds 缺席时找任意带句柄项）。
  const anyWithHandle = capture.elements.find((element) => element.native);
  const read = await backend.methods.read_element({ native: anyWithHandle.native });
  assert.equal(read.ok, true, "capture 后立即 read_element 必须命中句柄");
  assert.equal(read.element.owner_pid, anyWithHandle.owner_pid);
  // 未知句柄 fail-closed。
  const stale = await backend.methods.read_element({ native: "koffi-el-does-not-exist" });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "stale_element");
  backend.dispose();
});

test("darwin：未知方法不在表中（callBroker 层抛错，fail-closed 对齐 socket 语义）", { skip: !IS_DARWIN }, async () => {
  const backend = createKoffiBrokerMethods({ allowActions: false });
  // 方法表只收录 Phase 1 实现；pip_start 未收录 → callBroker 的查表层抛错
  //（index.js 的 inProcessMethods 分支）。这里锚定"不在表"这一事实。
  assert.ok(!("pip_start" in backend.methods), "未实现方法不得进表");
  assert.ok(!("controller_takeover" in backend.methods));
  backend.dispose();
});

test("darwin：动作开关打开后动作面在列（不真实执行输入合成）", { skip: !IS_DARWIN }, async () => {
  const backend = createKoffiBrokerMethods({ allowActions: true });
  for (const expected of ["click", "scroll", "press_key", "type_text", "element_press", "paste"]) {
    assert.ok(typeof backend.methods[expected] === "function", `动作面缺 ${expected}`);
  }
  const info = await backend.methods.broker_info({});
  assert.equal(info.capabilities.synthetic_input, true);
  backend.dispose();
});

test("withCFString：回调抛错仍走释放（不吞业务异常）", { skip: !IS_DARWIN }, () => {
  const bindings = loadKoffiBindings();
  assert.throws(
    () =>
      withCFString(bindings, "probe", () => {
        throw new Error("business error");
      }),
    /business error/,
  );
});

// ── P1-f：save_panel/open_panel 分类 + 表面生命周期差分 ──────────────

test("面板分类：save 优先于 open；无面板特征回落 attached_dialog", () => {
  assert.equal(sheetPanelKindFromButtons(true, false), "save_panel");
  assert.equal(sheetPanelKindFromButtons(true, true), "save_panel", "保存面板可带打开类次级按钮");
  assert.equal(sheetPanelKindFromButtons(false, true), "open_panel");
  assert.equal(sheetPanelKindFromButtons(false, false), "attached_dialog");
});

test("表面生命周期差分：首测 stable；一致 stable；增减 replaced；全无 closed", () => {
  const prev = new Set(["window:未命名", "save_panel:"]);
  assert.equal(surfaceLifecycleFromDiff(undefined, prev), "stable", "首次观测");
  assert.equal(surfaceLifecycleFromDiff(prev, new Set(prev)), "stable");
  assert.equal(
    surfaceLifecycleFromDiff(prev, new Set(["window:未命名", "attached_dialog:确认"])),
    "replaced",
    "表面集合变化",
  );
  assert.equal(
    surfaceLifecycleFromDiff(prev, new Set(["window:未命名"])),
    "replaced",
    "表面消失但仍有窗口主体",
  );
  assert.equal(
    surfaceLifecycleFromDiff(new Set(["save_panel:"]), new Set()),
    "closed",
    "上次有附加表面本次全无",
  );
  assert.equal(surfaceLifecycleFromDiff(prev, new Set(), { hasWindow: false }), "closed");
  assert.equal(surfaceLifecycleFromDiff(undefined, new Set(), { hasWindow: false }), "stable", "首测无窗仍 stable");
});

test("P1-e App 指南：7 个基线指南按 bundle_id 键全可载；显示名通道兜底", () => {
  const cases = [
    ["notion.id", "Notion Computer Use"],
    ["com.tinyspeck.slackmacgap", "Slack Computer Use"],
    ["com.spotify.client", "Spotify Computer Use"],
    ["com.apple.iWork.Numbers", "Numbers Computer Use"],
    ["com.apple.Music", "Music Computer Use"],
    ["com.apple.clock", "Clock Computer Use"],
    ["com.apple.ScreenContinuity", "iPhone Mirroring Instructions"],
  ];
  for (const [key, marker] of cases) {
    const content = loadAppInstruction(key);
    assert.ok(content, key);
    assert.ok(content.includes(marker), `${key} → ${marker}`);
  }
  // 显示名通道（capture_app 的 app_ref 传名场景）：本仓自写的 3 个指南无名称键文件，
  // 名称通道对它们缺席（返回 undefined）——双通道语义即 bundle_id 优先、名称兜底。
  assert.equal(loadAppInstruction("com.unknown.app"), undefined);
  assert.equal(loadAppInstruction(""), undefined);
});
