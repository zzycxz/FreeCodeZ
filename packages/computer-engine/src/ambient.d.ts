// FreeCodeZ 环境垫片（非 orca 原件）：orca 的 tsconfig 带 Electron/DOM 全局类型，
// 本包为纯 Node 目标；拷贝件只引用到 process.resourcesPath 与 window 存在性判断，
// 用最小环境声明补齐，产码保持零改动。
declare namespace NodeJS {
  interface Process {
    resourcesPath?: string;
  }
}

declare const window: unknown;
