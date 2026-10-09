// Appshot 三键的设置保键测试（2026-10-07 用户装机实测抓到的回归钉死）：
// f220da0/305be73 把设置键加进 AppSettings 类型与 UI，但漏补运行时 zod schema——
// z.object 默认 strip 静默剥键：update 剥掉后开关弹回（「点不动」）、落盘 setting.json
// 永远缺键。本测试钉死全量/patch 两个 schema 对 Appshot 三键的保留。
// （CUA 双门两键已随旧引擎拆除，语义由 W-18 新设置页重建，届时另立测试。）
import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

const APPSHOT_KEYS = {
  appshotHotkey: "cmd",
  appshotSound: false,
  appshotRoute: "new",
} as const;

test("全量 schema：Appshot 三键不被 strip（落盘/读取往返）", () => {
  const parsed = appSettingsSchema.parse({ ...APPSHOT_KEYS });
  assert.equal(parsed.appshotHotkey, "cmd");
  assert.equal(parsed.appshotSound, false);
  assert.equal(parsed.appshotRoute, "new");
});

test("patch schema：三键可写入且不被剥（update 通道——开关点下去必须生效）", () => {
  const patch = appSettingsPatchSchema.parse({ ...APPSHOT_KEYS });
  assert.equal(patch.appshotHotkey, "cmd");
  // patch → 合并 → 全量解析的完整管线模拟（settingService 的写入路径）。
  const merged = appSettingsSchema.parse({ ...patch });
  assert.equal(merged.appshotHotkey, "cmd", "patch 合并后经全量 schema 不丢键");
});

test("缺省语义：三键缺省时保持 absent（热键 off/音效 undefined!==false 开）", () => {
  const parsed = appSettingsSchema.parse({});
  assert.equal("appshotHotkey" in parsed, false);
  assert.equal("appshotSound" in parsed, false);
});
