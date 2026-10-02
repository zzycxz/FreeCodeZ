import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { applyBashSourcesToExecutionRequest } from "./bash-startup-script.js";
import { createBashResourceTelemetry } from "./bash-resource-telemetry.js";
import { createCwdCapturePlan } from "./cwd-capture.js";
import {
  applyResolvedShellCommand,
  buildExecutionEnv,
  resolveExecutionCommand,
  setResolvedShellLoginMode,
} from "./execution-command.js";
import { NodeExecutionAdapterResults } from "./node-execution-adapter-results.js";
import { createExecutionOutputStreamDecoder } from "./outputEncoding.js";
import type { OutputCollector } from "./output-collector.js";
import { wrapCommandWithSandbox } from "./sandbox/wrap.js";

/** E-S4(W)：Windows 包装结果额外携带的 workspace 降标指令（icacls 参数）。 */
interface SandboxLabelExtras {
  labelArgs?: string[];
}
import {
  BASH_SIGTERM_TO_SIGKILL_MS,
  signalPosixProcessTree,
  terminateGenericPosixProcessGroup,
} from "./process-tree.js";
import {
  revalidateShellInitSnapshotForExecution,
  supportsShellInitSnapshot,
} from "./shell-init-snapshot.js";
import {
  IO_DRAIN_TIMEOUT_MS,
  resolveDefaultOutputRootDir,
  sanitizePathSegment,
  waitForPromise,
} from "./execution-utils.js";
import type {
  ExitState,
  InternalExecutionRunOptions,
  PreparedChildSpawn,
} from "./execution-adapter-types.js";
import type { ExecutionRequest, ExecutionRunOptions } from "@zcode/contracts";

export class NodeExecutionAdapterProcess extends NodeExecutionAdapterResults {
  protected trackBashResources(
    child: ChildProcess,
    isBash: boolean,
    stopState: () => { timedOut: boolean; killed: boolean },
  ): (state: ExitState) => void {
    if (!isBash || !this.options.onToolExecResource) return () => {};
    const telemetry = createBashResourceTelemetry({
      platform: this.platform,
      processGroupId: child.pid,
      onComplete: this.options.onToolExecResource,
    });
    return (state) => {
      const stop = stopState();
      telemetry.finish(
        stop.timedOut
          ? "timeout"
          : stop.killed || state.signal
            ? "killed"
            : state.error
              ? "error"
              : "completed",
      );
    };
  }

  protected async prepareChildSpawn(request: ExecutionRequest): Promise<PreparedChildSpawn> {
    const env = buildExecutionEnv(request.env, {
      network: this.options.network,
      platform: this.platform,
      processEnv: this.processEnv,
    });
    const resolvedCommand = resolveExecutionCommand(request.command, {
      cwd: request.cwd,
      env,
      platform: this.platform,
    });
    const rootDir =
      this.options.outputRootDir ?? resolveDefaultOutputRootDir(this.options.processEnv);
    const sessionId = sanitizePathSegment(String(request.trace?.sessionId ?? "unknown-session"));
    const snapshotEnv = resolvedCommand.envOverlay
      ? { ...env, ...resolvedCommand.envOverlay }
      : env;
    const shellInitSnapshot =
      request.command.mode === "shell" &&
      request.command.shellProfile === "posix-bash" &&
      resolvedCommand.shell === false &&
      supportsShellInitSnapshot(resolvedCommand.cwdDialect)
        ? await revalidateShellInitSnapshotForExecution(
            await this.shellInitSnapshots.getOrCreate({
              env: snapshotEnv,
              rootDir,
              shellDialect: resolvedCommand.cwdDialect,
              shellPath: resolvedCommand.file,
            }),
          )
        : undefined;
    const useLoginShell = shellInitSnapshot ? false : true;
    const resolvedShell = setResolvedShellLoginMode(resolvedCommand, useLoginShell);
    const requestWithSources = applyBashSourcesToExecutionRequest(request, {
      leadingSources: shellInitSnapshot
        ? [
            {
              optional: true,
              path: shellInitSnapshot.path,
              shellPath: shellInitSnapshot.shellPath,
            },
          ]
        : [],
      rootDir,
      sessionId,
      shellDialect: resolvedCommand.cwdDialect,
    });
    const capturePlan = createCwdCapturePlan(requestWithSources, {
      dialect: resolvedCommand.cwdDialect,
      platform: this.platform,
    });
    const command =
      capturePlan.command === requestWithSources.command
        ? requestWithSources.command.mode === "shell"
          ? applyResolvedShellCommand(resolvedShell, requestWithSources.command.command)
          : resolvedShell
        : resolveExecutionCommand(capturePlan.command, {
            cwd: request.cwd,
            env,
            platform: this.platform,
            resolvedShell,
          });
    const spawnEnv = command.envOverlay ? { ...env, ...command.envOverlay } : env;
    // E-S1/S4：沙箱包装是 spawn 前的最后一跳（darwin=seatbelt / linux=bwrap /
    // win32=低完整级 MIC）。cwd 捕获/输出采集/进程树终止都作用在包装后的进程上，
    // 链路照旧。默认 off（policy 未启用原样返回，行为与现状一致）。
    const sandboxWrap = wrapCommandWithSandbox({
      policy: request.sandbox,
      platform: this.platform,
      command,
    });
    // E-S4(W)：Windows MIC 方案的 workspace 降标（icacls，幂等、~10ms、无需恢复
    // ——Medium 进程写 Low 标对象是向下写仍然允许，不影响正常工作流）。
    const labelArgs = (sandboxWrap as SandboxLabelExtras).labelArgs;
    if (labelArgs) {
      await new Promise<void>((resolve) => {
        const labeller = spawn("icacls.exe", labelArgs, { stdio: "ignore", windowsHide: true });
        labeller.on("error", () => resolve());
        labeller.on("close", () => resolve());
      });
    }
    // E-S3 配套：沙箱激活时预重定向包管理器缓存到 workspace 内。E2 实测 npm install
    // 必死于 ~/.npm（EPERM 且报错误导）；预注入让首次安装直接成功（零弹窗零失败），
    // 用户显式设置的变量不被覆盖。pip 同理（~/.cache/pip 在界外）。
    if (sandboxWrap.sandboxed && request.sandbox?.workspaceRoot) {
      const cacheRoot = `${request.sandbox.workspaceRoot.replace(/[\\/]+$/, "")}/.tmp`;
      if (!hasEnvValue(spawnEnv, "npm_config_cache") && !hasEnvValue(spawnEnv, "NPM_CONFIG_CACHE")) {
        spawnEnv.npm_config_cache = `${cacheRoot}/npm-cache`;
      }
      if (!hasEnvValue(spawnEnv, "PIP_CACHE_DIR")) {
        spawnEnv.PIP_CACHE_DIR = `${cacheRoot}/pip-cache`;
      }
      // Windows MIC：用户 TEMP 是 Medium IL，Low IL 进程写不了——必须一并重定向
      // 进 workspace（其 Low 标可继承），否则大量工具在临时目录上首步即败。
      if (this.platform === "win32") {
        if (!hasEnvValue(spawnEnv, "TMP")) spawnEnv.TMP = `${cacheRoot}/tmp`;
        if (!hasEnvValue(spawnEnv, "TEMP")) spawnEnv.TEMP = `${cacheRoot}/tmp`;
      }
    }
    const effectiveCommand = sandboxWrap.command;
    const baseOptions = {
      cwd: request.cwd,
      detached: this.platform !== "win32",
      env: spawnEnv,
      shell: effectiveCommand.shell,
      stdio: [
        request.stdin === undefined ? "ignore" : "pipe",
        "pipe",
        "pipe",
      ] satisfies StdioOptions,
      windowsHide: true,
    };

    return {
      command: effectiveCommand,
      cwdDialect: effectiveCommand.cwdDialect,
      cwdFilePath: capturePlan.cwdFilePath,
      spawnOptions: baseOptions,
      // fail-open 留痕：显式要求沙箱但无法满足（平台不支持/运行时缺失/无根）时
      // 原样执行并暴露原因——绝不让正常命令因沙箱不可用而失败（红线：零新增失败）。
      sandbox: { applied: sandboxWrap.sandboxed, skippedReason: sandboxWrap.skippedReason },
    };
  }

  protected terminateProcessTree(child: ChildProcess, useBashProcessTreeStop: boolean): void {
    if (!child.pid) {
      child.kill("SIGTERM");
      return;
    }

    if (this.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const completion = new Promise<void>((resolve) => {
        killer.once("error", () => {
          child.kill("SIGKILL");
          resolve();
        });
        killer.once("close", () => resolve());
      });
      if (useBashProcessTreeStop) {
        // 直写后不再等待 pipe EOF，shutdown 必须显式等待 taskkill 收尾，避免提前释放资源。
        this.pendingBashProcessTreeKills.set(completion, killer);
        void completion.finally(() => this.pendingBashProcessTreeKills.delete(completion));
      }
      return;
    }

    if (!useBashProcessTreeStop) {
      // PPID 后代枚举只修复 Bash job-control 的跨 PGID 清理；通用 hook、
      // shell 和 argv execution 必须保留既有进程组边界，避免修复能力扩散到其它调用方。
      terminateGenericPosixProcessGroup(child);
      return;
    }

    const rootPid = child.pid;
    // Bash job control、pipeline、xargs 和 PTY 可以把 worker 放入不同 PGID。
    // 两阶段清理各自快照当时的 PPID 后代，不跨阶段记忆进程身份。
    void signalPosixProcessTree(rootPid, "SIGTERM");
    let timer!: NodeJS.Timeout;
    const escalation = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        try {
          process.kill(-rootPid, "SIGKILL");
        } catch {
          // 直接的 force group kill 只做 best effort，随后仍会执行完整杀树。
        }
        // shutdown 等待实际查表与信号发送，不能在异步杀树刚启动时就释放清理所有权。
        void signalPosixProcessTree(rootPid, "SIGKILL").then(resolve);
      }, BASH_SIGTERM_TO_SIGKILL_MS);
      timer.unref?.();
    });
    this.pendingBashProcessTreeKills.set(escalation, timer);
    void escalation.finally(() => {
      this.pendingBashProcessTreeKills.delete(escalation);
    });
  }

  protected destroyChildOutputStreams(child: ChildProcess): void {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }

  protected attachPipedOutput(
    child: ChildProcess,
    stdout: OutputCollector,
    stderr: OutputCollector,
    encoding: string | null,
    options: ExecutionRunOptions,
  ): void {
    for (const [name, collector] of [
      ["stdout", stdout],
      ["stderr", stderr],
    ] as const) {
      const stream = child[name];
      const decoder = createExecutionOutputStreamDecoder(encoding);
      stream?.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        collector.append(buffer, stream);
        this.emit(options, {
          type: name,
          chunk: buffer,
          text: decoder.write(buffer),
          timestamp: new Date(),
        });
      });
    }
  }

  protected writeChildInput(
    child: ChildProcess,
    input: ExecutionRequest["stdin"],
  ): () => Error | undefined {
    let failure: Error | undefined;
    if (input !== undefined && child.stdin) {
      const capture = (error: Error) => {
        failure ??= error;
      };
      // Hook 可以提前关闭 stdin，异步 EPIPE 必须有监听，不能让 Agent 崩溃。
      child.stdin.on("error", capture);
      try {
        child.stdin.end(input);
      } catch (error) {
        capture(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return () => failure;
  }

  protected async drainChildOutput(
    child: ChildProcess,
    closed: Promise<void>,
    options: InternalExecutionRunOptions,
    terminationRequested: boolean,
  ): Promise<void> {
    if (await waitForPromise(closed, IO_DRAIN_TIMEOUT_MS)) return;
    // 通用 argv/Hook 保留 pipe EOF 所有权；Bash 直写文件不会进入此路径。
    if (options.shouldRetainExecutionAfterRootExit?.() === true) {
      await closed;
      return;
    }
    if (!terminationRequested) this.terminateProcessTree(child, false);
    if (!(await waitForPromise(closed, IO_DRAIN_TIMEOUT_MS))) this.destroyChildOutputStreams(child);
  }
}

// E-S3：env 键存在性检查（Windows 大小写不敏感兜底）。
function hasEnvValue(env: Record<string, string | undefined>, key: string): boolean {
  if (env[key] !== undefined && env[key] !== "") return true;
  const lower = key.toLowerCase();
  if (process.platform === "win32") {
    return Object.keys(env).some(
      (existing) => existing.toLowerCase() === lower && env[existing] !== undefined && env[existing] !== "",
    );
  }
  return false;
}
