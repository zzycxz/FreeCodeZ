import { formatJson } from "@zcode/core";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import { loadCliDotenv } from "./env.js";
import type { RunDependencies } from "./cli-types.js";

export async function runLoginCommand(
  ctx: RunContext,
  _options: GlobalOptions,
  _deps: RunDependencies,
  _noBrowser: boolean,
  _args: readonly string[] = [],
): Promise<number> {
  // FreeCodeZ fork:登录链已删(规格书 P2 §4.8);命令保留但立即失败,不触网。
  // 原 P1 基线实现曾以不可达死代码形态保留("待品牌清扫批次物理删除")——不可达代码
  // 阻断 TS 控制流收窄，providerId/error 的五个类型错误以潜行状态存活(cli typecheck
  // 不在门禁内)；2026-10-07 物理删除，writeAuthorizeUrl/formatUserLabel 死 helper 一并清理。
  ctx.stderr?.write?.("login is not available in FreeCodeZ; configure an API key instead.\n");
  return 1;
}

export async function runLogoutCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
): Promise<number> {
  try {
    const env = deps.env ?? process.env;
    const workingDirectory = (deps.cwd ?? process.cwd)();
    const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
      cwd: workingDirectory,
      env,
    });

    if (dotenvResult.error) {
      throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
        cause: dotenvResult.error,
      });
    }

    const logout = deps.logoutZCodeCli ?? (await loadBootstrapModule()).logoutZCodeCli;
    const result = await logout({ env });

    if (options.json) {
      ctx.stdout.write(
        formatJson({
          status: "logged_out",
          provider: "zai",
          credentialsPath: result.credentialsPath,
        }),
      );
      return 0;
    }

    ctx.stdout.write(
      `Logged out from Coding Plan accounts. Credentials: ${result.credentialsPath}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
}
