// FreeCodeZ fork(2026-09-24 移动端远程控制):手机端任务首页偏好纯函数单测——
// 两字段同时合法否则整体回退（附录C §7.7 i5t 语义）、storage 读写静默容错、
// collapse-navigation-once 武装/消费一次性语义（源码 Zvn/Qvn：跨 workspace 武装写
// "1"、下次挂载读到即 removeItem 收起一次；勘误：存 sessionStorage 非 localStorage）。
// 合同见 docs/spec/web-remote-control.md。
// 运行:node --import tsx --test packages/services/test/webRemoteMobilePreferences.test.ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MOBILE_TASK_HOME_PREFERENCES,
  MOBILE_COLLAPSE_NAVIGATION_ONCE_KEY,
  MOBILE_TASK_HOME_PREFERENCES_KEY,
  armCollapseNavigationOnce,
  consumeCollapseNavigationOnce,
  parseMobileTaskHomePreferences,
  readMobileTaskHomePreferences,
  serializeMobileTaskHomePreferences,
  writeMobileTaskHomePreferences,
  type StorageLike,
} from "../../ui/src/mobile/mobilePreferences.js";

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

test("偏好解析:两字段同时合法才接受,否则整体回退默认值", () => {
  assert.deepEqual(parseMobileTaskHomePreferences(null), DEFAULT_MOBILE_TASK_HOME_PREFERENCES);
  assert.deepEqual(parseMobileTaskHomePreferences("not-json"), DEFAULT_MOBILE_TASK_HOME_PREFERENCES);
  assert.deepEqual(parseMobileTaskHomePreferences("[]"), DEFAULT_MOBILE_TASK_HOME_PREFERENCES);
  // 只有一个字段合法:整体回退,不逐字段兜底
  assert.deepEqual(
    parseMobileTaskHomePreferences(JSON.stringify({ organizeBy: "timeline", sortBy: "nonsense" })),
    DEFAULT_MOBILE_TASK_HOME_PREFERENCES,
  );
  assert.deepEqual(
    parseMobileTaskHomePreferences(JSON.stringify({ organizeBy: "project", sortBy: "created" })),
    DEFAULT_MOBILE_TASK_HOME_PREFERENCES,
  );
  assert.deepEqual(
    parseMobileTaskHomePreferences(JSON.stringify({ sortBy: "created" })),
    DEFAULT_MOBILE_TASK_HOME_PREFERENCES,
  );
  assert.deepEqual(parseMobileTaskHomePreferences('{"organizeBy":"timeline","sortBy":"created"}'), {
    organizeBy: "timeline",
    sortBy: "created",
  });
});

test("偏好读写:roundtrip 稳定,storage 异常静默回退", () => {
  const storage = fakeStorage();
  writeMobileTaskHomePreferences(storage, { organizeBy: "timeline", sortBy: "created" });
  assert.equal(storage.data.get(MOBILE_TASK_HOME_PREFERENCES_KEY), serializeMobileTaskHomePreferences({ organizeBy: "timeline", sortBy: "created" }));
  assert.deepEqual(readMobileTaskHomePreferences(storage), { organizeBy: "timeline", sortBy: "created" });

  const broken: StorageLike = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  assert.deepEqual(readMobileTaskHomePreferences(broken), DEFAULT_MOBILE_TASK_HOME_PREFERENCES);
  // 写失败不得抛异常
  writeMobileTaskHomePreferences(broken, { organizeBy: "workspace", sortBy: "updated" });
  consumeCollapseNavigationOnce(broken);
});

test("collapse-navigation-once:跨 workspace 武装一次,下次挂载读到即清除收起一次(Zvn/Qvn 源码语义)", () => {
  const storage = fakeStorage();
  // Zvn:未武装 → false,且消费动作不写 key(旧推断"首次进入写 key 返回 true"被源码推翻)
  assert.equal(consumeCollapseNavigationOnce(storage), false);
  assert.equal(storage.data.has(MOBILE_COLLAPSE_NAVIGATION_ONCE_KEY), false);
  // Qvn:跨 workspace 武装写 "1"
  armCollapseNavigationOnce(storage);
  assert.equal(storage.data.get(MOBILE_COLLAPSE_NAVIGATION_ONCE_KEY), "1");
  // Zvn:读到 "1" → removeItem + true(读到即清)
  assert.equal(consumeCollapseNavigationOnce(storage), true);
  assert.equal(storage.data.has(MOBILE_COLLAPSE_NAVIGATION_ONCE_KEY), false);
  assert.equal(consumeCollapseNavigationOnce(storage), false);
  // 非 "1" 值不命中
  storage.data.set(MOBILE_COLLAPSE_NAVIGATION_ONCE_KEY, "0");
  assert.equal(consumeCollapseNavigationOnce(storage), false);
});
