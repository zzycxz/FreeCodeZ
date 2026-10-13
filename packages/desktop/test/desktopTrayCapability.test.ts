// U3-4（移植自 ZCode 3.15.1）linux 关窗驻留能力探测纯件测试：三客户端任一 true 即
// supported；全失败=unsupported；GNOME 裸环境给 gnomeLikeWithoutTray；监视器 10s 缓存。
import assert from "node:assert/strict";
import test from "node:test";
import {
  createCloseToTrayCapabilityMonitor,
  detectLinuxCloseToTrayCapability,
  probeResponseIndicatesTraySupport,
} from "../src/main/desktopTrayCapability.js";

const GNOME_ENV = { XDG_CURRENT_DESKTOP: "ubuntu:GNOME", XDG_SESSION_DESKTOP: "gnome" };

test("三形态应答解析：gdbus/busctl/qdbus 全认", () => {
  assert.equal(probeResponseIndicatesTraySupport("(true,)"), true);
  assert.equal(probeResponseIndicatesTraySupport('b "true"'), true);
  assert.equal(probeResponseIndicatesTraySupport("true"), true);
  assert.equal(probeResponseIndicatesTraySupport("(false,)"), false);
});

test("gdbus 命中即 supported（短路不再问 busctl/qdbus）", async () => {
  const asked: string[] = [];
  const capability = await detectLinuxCloseToTrayCapability({
    run: async (file) => {
      asked.push(file);
      return file === "gdbus" ? "(true,)" : "";
    },
    env: {},
  });
  assert.equal(capability.supported, true);
  assert.deepEqual(asked, ["gdbus"]);
});

test("全客户端失败 = unsupported；GNOME 裸环境给 gnomeLikeWithoutTray", async () => {
  const capability = await detectLinuxCloseToTrayCapability({
    run: async () => {
      throw new Error("no gdbus/busctl/qdbus");
    },
    env: GNOME_ENV,
  });
  assert.equal(capability.supported, false);
  assert.equal(capability.gnomeLikeWithoutTray, true);
});

test("非 GNOME 的失败环境不给 gnome 提示位", async () => {
  const capability = await detectLinuxCloseToTrayCapability({
    run: async () => "",
    env: { XDG_CURRENT_DESKTOP: "KDE" },
  });
  assert.equal(capability.gnomeLikeWithoutTray, false);
});

test("监视器缓存 10s：过期后 getSync 返回 null 交由调用方重探", async () => {
  let calls = 0;
  const monitor = createCloseToTrayCapabilityMonitor({
    detect: async () => {
      calls += 1;
      return { supported: calls > 0, gnomeLikeWithoutTray: false };
    },
  });
  assert.equal(monitor.getSync(), null);
  await monitor.refresh();
  assert.equal(monitor.getSync()?.supported, true);
  // 同步再取仍走缓存（不新增探测次数）
  monitor.getSync();
  assert.equal(calls, 1);
});
