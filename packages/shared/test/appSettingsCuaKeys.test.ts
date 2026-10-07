// CUA 双门 + Appshot 三键的设置保键测试（2026-10-07 用户装机实测抓到的回归钉死）：
// f220da0/305be73 把五键加进 AppSettings 类型与 UI，但漏补运行时 zod schema——
// z.object 默认 strip 静默剥键：update 剥掉后开关弹回（「点不动」）、落盘 setting.json
// 永远缺五键。本测试钉死全量/patch 两个 schema 对五键的保留。
import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

const CUA_KEYS = {
  cuaControlEnabled: true,
  cuaActionsEnabled: true,
  appshotHotkey: "cmd",
  appshotSound: false,
  appshotRoute: "new",
} as const;

test("全量 schema：CUA/Appshot 五键不被 strip（落盘/读取往返）", () => {
  const parsed = appSettingsSchema.parse({ ...CUA_KEYS });
  assert.equal(parsed.cuaControlEnabled, true);
  assert.equal(parsed.cuaActionsEnabled, true);
  assert.equal(parsed.appshotHotkey, "cmd");
  assert.equal(parsed.appshotSound, false);
  assert.equal(parsed.appshotRoute, "new");
});

test("patch schema：五键可写入且不被剥（update 通道——开关点下去必须生效）", () => {
  const patch = appSettingsPatchSchema.parse({ ...CUA_KEYS });
  assert.equal(patch.cuaControlEnabled, true);
  assert.equal(patch.appshotHotkey, "cmd");
  // patch → 合并 → 全量解析的完整管线模拟（settingService 的写入路径）。
  const merged = appSettingsSchema.parse({ ...patch });
  assert.equal(merged.cuaControlEnabled, true, "patch 合并后经全量 schema 不丢键");
});

test("缺省语义：五键缺省时保持 absent（观测关/热键 off/音效 undefined!==false 开）", () => {
  const parsed = appSettingsSchema.parse({});
  assert.equal("cuaControlEnabled" in parsed, false);
  assert.equal("appshotHotkey" in parsed, false);
  assert.equal("appshotSound" in parsed, false);
});
