import { logger } from "./logger.js";
import { initializeCrashCapture, type CrashCapturePaths } from "./desktopCrashCapture.js";

// 先由 desktopEarlyDataBaseDirBootstrap 注入 dataBaseDir，再配置 crashDumps。
// FreeCodeZ fork:ARMS 已删,恢复仅本地的 crashReporter(uploadToServer:false,
// 归档 ~/.freecodez/v2/crash/archive)(规格书 P3 §3.4)。
export const crashCapturePaths: CrashCapturePaths = initializeCrashCapture(logger, false);
