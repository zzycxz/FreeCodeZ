// FreeCodeZ 宿主 fork 驱动 harness（非 orca 原件，W-10）。
// 驱动形态照 orca macos-computer-helper-owner-loss-benchmark.mjs 的 startSidecar/
// requestSidecar：fork + {id, method, params} 请求/响应 + 超时 + stderr 收集；
// 本件补串行队列（sidecar 派发侧无并发语义，宿主侧逐请求排队）。
import { fork, type ChildProcess } from "node:child_process";

export type SidecarErrorResponse = {
  id: number;
  ok: false;
  error: { code?: string; message?: string; data?: unknown };
};
export type SidecarOkResponse = { id: number; ok: true; result: unknown };
export type SidecarResponse = SidecarOkResponse | SidecarErrorResponse;

export interface ComputerSidecarHarnessOptions {
  /** sidecar 产物路径（dist/computer-sidecar.js） */
  sidecarPath: string;
  /** fork 执行体：缺省 process.execPath；装机/录制可换应用二进制（peer 信任面要求
   *  sidecar 跑在可信 app 身份下——W-11 红线：裸 node 不受信）。 */
  execPath?: string;
  execArgv?: string[];
  /** 单请求超时；缺省 60s（附录 I 超时矩阵的宿主侧兜底） */
  requestTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export class ComputerSidecarHarness {
  private readonly child: ChildProcess;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<
    number,
    { resolve: (value: SidecarResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  readonly errors: string[] = [];

  constructor(options: ComputerSidecarHarnessOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.child = fork(options.sidecarPath, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, ...options.env },
      ...(options.execPath ? { execPath: options.execPath } : {}),
      // sidecar 是构建产物，不继承父进程 execArgv（父可能是 test runner/tsx，
      // 其旗标 Electron-as-node 不认）；显式需要时经 options.execArgv 传。
      execArgv: options.execArgv ?? [],
    });
    this.child.on("error", (error) => this.errors.push(error.stack ?? error.message));
    this.child.stderr?.on("data", (chunk) => this.errors.push(String(chunk)));
    this.child.on("message", (message: unknown) => {
      const id = (message as { id?: unknown } | null)?.id;
      if (typeof id !== "number") return;
      const entry = this.pending.get(id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve(message as SidecarResponse);
    });
    this.child.on("exit", () => {
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(new Error(`sidecar exited before responding to #${id}: ${this.errors.join("")}`));
      }
    });
  }

  /** 串行请求：同一 harness 上的调用逐个排队，响应或超时后放行下一个。 */
  request(method: string, params?: Record<string, unknown>): Promise<SidecarResponse> {
    const run = this.queue.then(() => this.requestOnce(method, params));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private requestOnce(method: string, params?: Record<string, unknown>): Promise<SidecarResponse> {
    const id = this.nextId++;
    return new Promise<SidecarResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `sidecar ${method} request timed out after ${this.requestTimeoutMs}ms: ${this.errors.join("")}`,
          ),
        );
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, method, ...(params ? { params } : {}) });
    });
  }

  /** SIGTERM 停止（sidecar 的 SIGTERM handler 负责 provider teardown）；超时后强杀。 */
  async stop(timeoutMs = 5_000): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.kill("SIGTERM");
    const timer = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
    await Promise.race([exited, timer]);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await exited;
    }
  }
}
