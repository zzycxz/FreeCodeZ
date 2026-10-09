// R21/R21c 主应用权限自注册的请求面（CGRequestScreenCaptureAccess /
// AXIsProcessTrustedWithOptions）：① 授予/拒绝结果如实透传；② koffi 缺失 fail-closed；
// ③ 绑定抛错不向上抛（请求是尽力而为的注册动作，绝不阻断调用方主流程）；
// ④ AX 请求的 options 字典构造正确且用完即放（CFRelease ×2）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  requestAccessibilityAccess,
  requestScreenCaptureAccess,
} from "../macos/ax-observation.js";

test("requestScreenCaptureAccess：授予/拒绝如实透传", () => {
  assert.deepEqual(
    requestScreenCaptureAccess(() => ({ CGRequestScreenCaptureAccess: () => true })),
    { granted: true, koffiAvailable: true },
  );
  assert.deepEqual(
    requestScreenCaptureAccess(() => ({ CGRequestScreenCaptureAccess: () => false })),
    { granted: false, koffiAvailable: true },
  );
});

test("requestScreenCaptureAccess：koffi 缺失 fail-closed、绑定抛错不向上抛", () => {
  assert.deepEqual(requestScreenCaptureAccess(() => null), {
    granted: false,
    koffiAvailable: false,
  });
  assert.deepEqual(
    requestScreenCaptureAccess(() => ({
      CGRequestScreenCaptureAccess: () => {
        throw new Error("koffi type error");
      },
    })),
    { granted: false, koffiAvailable: true },
  );
});

test("requestAccessibilityAccess：真实 AX 读触发注册 + 用完即放 + granted 透传", () => {
  const released = [];
  const calls = [];
  const bindings = {
    AXUIElementCreateSystemWide: () => ({ element: true }),
    AXUIElementCopyAttributeNames: (_element, out) => {
      calls.push("copy-names");
      out[0] = { names: true };
      return 0;
    },
    AXIsProcessTrusted: () => true,
    CFRelease: (ref) => released.push(ref),
  };
  assert.deepEqual(requestAccessibilityAccess(() => bindings), {
    granted: true,
    koffiAvailable: true,
  });
  assert.deepEqual(calls, ["copy-names"], "做一次真实 AX 读（未信任即触发系统注册/弹窗）");
  assert.equal(released.length, 2, "names 数组与 systemWide 元素都释放");
});

test("requestAccessibilityAccess：koffi 缺失 fail-closed、绑定抛错不向上抛", () => {
  assert.deepEqual(requestAccessibilityAccess(() => null), {
    granted: false,
    koffiAvailable: false,
  });
  assert.deepEqual(
    requestAccessibilityAccess(() => ({
      AXUIElementCreateSystemWide: () => {
        throw new Error("koffi type error");
      },
    })),
    { granted: false, koffiAvailable: true },
  );
});
