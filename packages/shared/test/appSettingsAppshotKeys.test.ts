// 设置键保键测试（2026-10-07 用户装机实测抓到的回归钉死 + W-18 电脑控制键回置）：
// z.object 默认 strip 会把键静默剥掉——update 剥键后开关弹回（「点不动」）、落盘缺失。
// W-18 语义沿用旧键名（cuaControlEnabled/cuaActionsEnabled/computerUseComposerEntryHidden）
// ——键在 schema 即存量值直读免迁移，本测试钉死三键 + Appshot 三键的全量/patch 保留。
import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

const KEYS = {
  cuaControlEnabled: true,
  cuaActionsEnabled: true,
  computerUseComposerEntryHidden: true,
  appshotHotkey: "cmd",
  appshotSound: false,
  appshotRoute: "new",
} as const;

test("全量 schema：电脑控制三键 + Appshot 三键不被 strip（落盘/读取往返）", () => {
  const parsed = appSettingsSchema.parse({ ...KEYS });
  assert.equal(parsed.cuaControlEnabled, true);
  assert.equal(parsed.cuaActionsEnabled, true);
  assert.equal(parsed.computerUseComposerEntryHidden, true);
  assert.equal(parsed.appshotHotkey, "cmd");
  assert.equal(parsed.appshotSound, false);
  assert.equal(parsed.appshotRoute, "new");
});

test("patch schema：六键可写入且不被剥（update 通道——开关点下去必须生效）", () => {
  const patch = appSettingsPatchSchema.parse({ ...KEYS });
  assert.equal(patch.cuaControlEnabled, true);
  assert.equal(patch.appshotHotkey, "cmd");
  const merged = appSettingsSchema.parse({ ...patch });
  assert.equal(merged.cuaControlEnabled, true, "patch 合并后经全量 schema 不丢键");
  assert.equal(merged.computerUseComposerEntryHidden, true);
});

test("缺省语义：键缺省时保持 absent（热键 off/音效 undefined!==false 开/电脑控制关）", () => {
  const parsed = appSettingsSchema.parse({});
  assert.equal("cuaControlEnabled" in parsed, false);
  assert.equal("computerUseComposerEntryHidden" in parsed, false);
  assert.equal("appshotHotkey" in parsed, false);
  assert.equal("appshotSound" in parsed, false);
});
