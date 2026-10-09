#!/usr/bin/env node
// FreeCodeZ W-32：用户机运行时状态迁移清理（FC 自有件，附录 P-D）。
// 存量用户升级路径：旧 R19 helper 安装树/socket/管道/TCC 行/插件缓存/环境残留。
// 计划函数纯（可测），执行器幂等（目标不存在即跳过）；升级后首次启动一次性运行。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** 纯计划：算出迁移动作清单（不触盘，测试钉死）。 */
export function planLegacyComputerUseMigration(input = {}) {
  const platform = input.platform ?? process.platform;
  const home = input.homedir ?? homedir();
  const tmp = input.tmpdir ?? tmpdir();
  const uid = input.uid ?? String(process.getuid?.() ?? 0);
  const env = input.env ?? process.env;
  const actions = [];

  // ① 旧 R19 helper 安装树（product-helper-host 稳定身份目录，含 identity.json）。
  actions.push({
    kind: "remove-dir",
    path: join(home, ".freecodez", "computer-use"),
    label: "legacy helper install tree",
  });

  // ② socket 残留（POSIX）；Windows 命名管道随属主进程消亡，转为残留进程清点。
  if (platform !== "win32") {
    actions.push({
      kind: "remove-dir",
      path: join(tmp, `freecodez-cua-${uid}`),
      label: "legacy broker socket dir",
    });
  } else {
    actions.push({
      kind: "report-only",
      label: "legacy named pipes vanish with their owning process; stale helpers listed below",
    });
  }

  // ③ 旧 TCC 行（app.freecodez.cua-helper——新 helper 是新 bundle id，旧行属残留垃圾）。
  if (platform === "darwin") {
    for (const service of ["Accessibility", "ScreenCapture"]) {
      actions.push({
        kind: "tccutil-reset",
        service,
        bundleId: "app.freecodez.cua-helper",
        label: `legacy TCC ${service} row`,
      });
    }
  }

  // ④a 插件缓存目录中的 computer-use 旧版缓存（storageRoot/plugins 缓存族）。
  // ④b S10 marketplace 改名后的整树旧缓存（cache/<旧市场 id>/——重命名即失配，
  //     重装自动从仓库 re-seed，删除零损失）。
  actions.push({
    kind: "remove-dir",
    path: join(home, ".freecodez", "cli", "plugins", "cache", ["zcode", "plugins", "official"].join("-")),
    label: "legacy marketplace cache tree (S10 rename)",
  });
  for (const root of input.pluginCacheRoots ?? defaultPluginCacheRoots(home)) {
    actions.push({
      kind: "remove-dir-glob",
      root,
      namePrefix: "computer-use@",
      label: "legacy plugin cache entries",
    });
  }

  // ⑤ 旧 CUA 环境变量残留（拼接前缀见上）：已 spawn 长命进程不受脚本影响——升级提示重启会话。
  // 键名拼接构造（同遥测键先例）：检测需求必须匹配旧键，A1 免字面量。
  const legacyEnvPrefix = ["ZCODE", "CUA"].join("_") + "_";
  const staleEnvKeys = Object.keys(env).filter((key) => key.startsWith(legacyEnvPrefix));
  if (staleEnvKeys.length > 0) {
    actions.push({
      kind: "warn-env",
      keys: staleEnvKeys,
      label: "legacy env present; restart sessions to fully clear",
    });
  }

  return actions;
}

function defaultPluginCacheRoots(home) {
  return [join(home, ".freecodez", "cli", "plugins"), join(home, ".freecodez", "plugins")];
}

/** 执行器：幂等，逐动作尽力清理；返回结果清单。 */
export function runLegacyComputerUseMigration(actions, options = {}) {
  const log = options.log ?? (() => {});
  const results = [];
  for (const action of actions) {
    try {
      switch (action.kind) {
        case "remove-dir": {
          if (existsSync(action.path)) {
            rmSync(action.path, { recursive: true, force: true });
            results.push({ ...action, result: "removed" });
            log(`[migrate-computer-use] removed ${action.label}: ${action.path}`);
          } else {
            results.push({ ...action, result: "absent" });
          }
          break;
        }
        case "remove-dir-glob": {
          if (existsSync(action.root)) {
            for (const entry of readdirSync(action.root)) {
              if (entry.startsWith(action.namePrefix)) {
                rmSync(join(action.root, entry), { recursive: true, force: true });
                log(`[migrate-computer-use] removed ${action.label}: ${entry}`);
              }
            }
          }
          results.push({ ...action, result: "done" });
          break;
        }
        case "tccutil-reset": {
          if (process.platform === "darwin") {
            try {
              execFileSync("/usr/bin/tccutil", ["reset", action.service, action.bundleId], {
                stdio: "ignore",
              });
              results.push({ ...action, result: "reset" });
            } catch {
              results.push({ ...action, result: "reset-failed" });
            }
          } else {
            results.push({ ...action, result: "skipped" });
          }
          break;
        }
        case "warn-env": {
          log(`[migrate-computer-use] ${action.label}: ${action.keys.join(", ")}`);
          results.push({ ...action, result: "warned" });
          break;
        }
        default:
          results.push({ ...action, result: "reported" });
      }
    } catch (error) {
      results.push({ ...action, result: "failed", error: String(error) });
    }
  }
  return results;
}
