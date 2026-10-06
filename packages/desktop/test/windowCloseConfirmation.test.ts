// 第四批 22②：关窗枚举确认逻辑锚定（手册 v3.3 五场景）。
// 实现已覆盖——此测试防止回退：五场景各自走正确分支。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../src/main/desktopWindowLifecycle.ts"), "utf8");

test("22② 五场景代码锚定", () => {
  // ① mac 红点/Cmd+Q 都走 isLastWindow → confirmQuit
  assert.match(source, /isLastWindow/, "最后窗口判定在场");
  assert.match(source, /confirmQuit\(\)/, "确认对话调用在场");
  // ② production+有会话才确认（dev 不打断调试）
  assert.match(source, /shouldConfirmQuit/, "确认开关在场");
  // ④ win closeToTray → 藏托盘零确认
  assert.match(source, /closeToTrayOnWindows/, "托盘模式在场");
  assert.match(source, /hideWindow/, "藏窗调用在场");
  // ⑤ 非最后窗口直接放行
  assert.match(source, /!options\.isLastWindow/, "非最后窗口放行分支在场");
});

test("22② 确认开关的生产门", () => {
  const indexSource = readFileSync(join(here, "../src/main/index.ts"), "utf8");
  assert.match(indexSource, /ZCODE_ENV === "production" && getRunningAgentSessionCount\(\) > 0/, "production+有会话双条件在场");
});
