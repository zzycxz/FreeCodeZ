// ============================================================
// R19（mac Helper 自研产线）：darwin 安装验签依赖（lipo/codesign）
// ============================================================
// 自 product-helper-host.js 拆出（max-lines 400 惯例，koffi-diagnostics 同款先例）。
// broker-server.defaultCuaHelperVerifierDependencies 在 darwin 下采用本实现。
// FC 全线 unsigned/adhoc 分发，故 verifyCodeSignature 只验「签名完整有效」不验信任链
//（adhoc 可过）；TeamIdentifier 校验仅在 env FREECODEZ_CUA_HELPER_TEAM_ID/
// ZCODE_CUA_HELPER_TEAM_ID 显式钉扎时介入（broker-server 消费）。

import { execFile as childProcessExecFile } from "node:child_process";
import { basename, join } from "node:path";

function helperExecutablePath(appPath) {
  return join(appPath, "Contents", "MacOS", basename(appPath).replace(/\.app$/, ""));
}

export function createDarwinVerifierDependencies({ execFileImpl = childProcessExecFile } = {}) {
  const run = (command, args) =>
    new Promise((resolve, reject) => {
      execFileImpl(command, args, { timeout: 10_000 }, (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve(String(stdout));
      });
    });
  return {
    async readExecutableArchs(appPath) {
      const out = await run("/usr/bin/lipo", ["-archs", helperExecutablePath(appPath)]);
      const archs = out
        .split(/\s+/)
        .map((item) => item.trim())
        .filter(Boolean);
      if (archs.length === 0) throw new Error("lipo reported no architectures");
      return archs;
    },
    async verifyCodeSignature(appPath) {
      await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
    },
    async verifyTeamIdentifier(appPath) {
      const out = await new Promise((resolve, reject) => {
        execFileImpl(
          "/usr/bin/codesign",
          ["-dv", "--verbose=4", appPath],
          { timeout: 10_000 },
          (error, _stdout, stderr) => {
            // codesign -dv 的输出在 stderr；退出码非 0 才是失败。
            if (error) {
              reject(error);
              return;
            }
            resolve(String(stderr ?? ""));
          },
        );
      });
      const match = /^TeamIdentifier=(.*)$/m.exec(out);
      if (!match) throw new Error("TeamIdentifier not present in codesign output");
      return match[1].trim();
    },
  };
}
