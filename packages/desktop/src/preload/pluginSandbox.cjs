// U3-0（移植自 ZCode 3.15.1 preload/pluginSandbox.cjs 职责对照——FC 基础版）：
// 沙箱 webview 专用 preload。只暴露最小的 host↔shell 双向中继桥；
// 内层 iframe（zcode-sandbox: 重发布的插件内容）与壳页同源通信，壳页经本桥把
// 事件转给 main；main→壳页方向经 WebContents 事件回注。无 Node/任意 IPC 能力外泄。
const { contextBridge, ipcRenderer } = require("electron");

const HOST_MESSAGE_CHANNEL = "zcode:plugin-sandbox-host-message";
const HOST_EVENT_CHANNEL = "zcode:plugin-sandbox-host-event";

const hostListeners = new Set();

ipcRenderer.on(HOST_EVENT_CHANNEL, (_event, payload) => {
  for (const listener of hostListeners) listener(payload);
});

contextBridge.exposeInMainWorld("pluginSandboxBridge", {
  /** 壳页 → main（插件 UI 事件上行；main 侧按 registry 归因）。 */
  hostMessage: (payload) => {
    ipcRenderer.send(HOST_MESSAGE_CHANNEL, payload);
  },
  /** main → 壳页（宿主指令/事件下行）。 */
  onHostMessage: (callback) => {
    hostListeners.add(callback);
    return () => hostListeners.delete(callback);
  },
});
