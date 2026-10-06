// ============================================================
// koffi broker 诊断面（自 koffi-broker-methods.js 拆出——max-lines 400 惯例）
// 语义零变化；allowActions 经参数注入（原闭包变量）。
// ============================================================

import { probePermissions } from "./ax-observation.js";

export function registerDiagnosticMethods(methods, { allowActions }) {
  methods.broker_info = async () => ({
    ok: true,
    backend: "koffi-in-process",
    platform: "darwin",
    capabilities: {
      ax_observation: true,
      synthetic_input: allowActions,
      screen_capture: probePermissions().screenCapture,
    },
    version: "phase1",
  });

  methods.permission_status = async () => {
    const status = probePermissions();
    return {
      ok: true,
      accessibility: status.accessibility,
      screen_capture: status.screenCapture,
      accessibility_trusted: status.accessibility,
    };
  };

  methods.screen_capture_status = async () => {
    const status = probePermissions();
    return { ok: true, available: status.screenCapture, authorized: status.screenCapture };
  };

  methods.screen_capture_probe = async () => {
    const status = probePermissions();
    return {
      ok: true,
      reason: status.screenCapture
        ? "granted"
        : "screen recording permission not granted to this process (grant to FreeCodeZ.app in System Settings → Privacy & Security → Screen Recording)",
    };
  };

  methods.supports_accessibility = async () => ({
    ok: true,
    supported: true,
    trusted: probePermissions().accessibility,
  });

  methods.input_permission_status = async () => ({
    ok: true,
    synthetic_input: allowActions,
    accessibility_trusted: probePermissions().accessibility,
  });

  methods.request_access = async () => {
    const status = probePermissions();
    return {
      ok: true,
      status: status.accessibility ? "granted" : "accessibility permission required (System Settings → Privacy & Security → Accessibility → FreeCodeZ)",
    };
  };
}
