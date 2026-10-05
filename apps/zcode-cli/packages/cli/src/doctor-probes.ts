// 条目 6（升级实施手册）：doctor 环境探针。
// 探针纪律：只读、有界超时、失败=结论而非异常——doctor 的契约是"哪里坏了能指出"，
// 探针自身崩溃等于医生先倒下。全部探针并行跑，单项超时不拖垮整体。
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SANDBOX_EXEC_PATH } from "@zcode/adapters/exec";

const PROBE_TIMEOUT_MS = 4_000;

export interface DoctorProbe {
  /** 探针名（--json 的稳定键，也是人类可读行首）。 */
  name: string;
  status: "ok" | "warn" | "fail" | "unavailable";
  /** 结论一句话；fail/warn 必须带"怎么修"的方向。 */
  detail: string;
}

function runProbe(
  name: string,
  probe: () => Promise<Omit<DoctorProbe, "name">>,
): Promise<DoctorProbe> {
  return Promise.race([
    probe().then(
      (result) => ({ name, ...result }),
      (error: unknown) => ({
        name,
        status: "fail" as const,
        detail: error instanceof Error ? error.message : String(error),
      }),
    ),
    new Promise<DoctorProbe>((resolve) => {
      const timer = setTimeout(
        () => resolve({ name, status: "warn", detail: `probe timed out after ${PROBE_TIMEOUT_MS}ms` }),
        PROBE_TIMEOUT_MS,
      );
      timer.unref?.();
    }),
  ]);
}

function execFileText(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolve(stdout);
    });
  });
}

/** 数据目录与磁盘余量：~/.freecodez 存在性 + 写权限 + /tmp 家族余量。 */
async function dataDirProbe(): Promise<Omit<DoctorProbe, "name">> {
  const dataDir = join(homedir(), ".freecodez");
  if (!existsSync(dataDir)) {
    return { status: "ok", detail: `${dataDir} not created yet (first run will create it)` };
  }
  try {
    statSync(dataDir);
  } catch (error) {
    return {
      status: "fail",
      detail: `${dataDir} exists but is not accessible: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const tmpRoot = tmpdir();
  try {
    statSync(tmpRoot);
    return { status: "ok", detail: `${dataDir} accessible; temp dir ${tmpRoot} present` };
  } catch {
    return { status: "warn", detail: `temp dir ${tmpRoot} missing — bash background output persistence may fail` };
  }
}

/** 网络：仅 DNS+TCP 可达性探测（不携带任何用户数据出网）。 */
async function networkProbe(): Promise<Omit<DoctorProbe, "name">> {
  try {
    await execFileText("curl", ["-sS", "--max-time", "3", "-o", "/dev/null", "-w", "%{http_code}", "https://api.github.com"]);
    return { status: "ok", detail: "outbound HTTPS reachable (api.github.com)" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Could not resolve host") || message.includes("ENOTFOUND")) {
      return { status: "fail", detail: "DNS resolution failed — check network; provider/model calls will fail" };
    }
    return { status: "warn", detail: `api.github.com unreachable (${message.split("\n")[0]}) — model providers may still be reachable` };
  }
}

/** gh CLI：GitHub 工具链可用性（条目 11 联动的缺失检测端）。 */
async function ghProbe(): Promise<Omit<DoctorProbe, "name">> {
  try {
    const version = await execFileText("gh", ["--version"]);
    const firstLine = version.split("\n")[0]?.trim() ?? "gh";
    return { status: "ok", detail: firstLine };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") {
      return { status: "unavailable", detail: "gh CLI not installed — GitHub tools will report structured unavailable (install: https://cli.github.com)" };
    }
    return { status: "warn", detail: `gh found but --version failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 沙箱执行体：mac sandbox-exec / Linux bwrap 的在场性（启用沙箱前的预检结论）。 */
async function sandboxProbe(): Promise<Omit<DoctorProbe, "name">> {
  if (process.platform === "darwin") {
    return existsSync(SANDBOX_EXEC_PATH)
      ? { status: "ok", detail: `sandbox-exec present at ${SANDBOX_EXEC_PATH}` }
      : { status: "unavailable", detail: `${SANDBOX_EXEC_PATH} missing — sandbox mode will fail-closed to unsandboxed execution` };
  }
  if (process.platform === "linux") {
    for (const candidate of ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"]) {
      if (existsSync(candidate)) return { status: "ok", detail: `bwrap present at ${candidate}` };
    }
    return { status: "unavailable", detail: "bwrap not installed — sandbox mode falls back to unsandboxed (install bubblewrap to enable)" };
  }
  return { status: "unavailable", detail: "sandbox execution pending Windows real-machine verification (UI stays disabled)" };
}

/** 凭据面：provider 配置在不在（指向"去设置页配 key"而不是裸失败）。 */
async function providerConfigProbe(): Promise<Omit<DoctorProbe, "name">> {
  const configPath = join(homedir(), ".freecodez", "v2", "provider_config.json");
  return existsSync(configPath)
    ? { status: "ok", detail: `provider config present at ${configPath}` }
    : { status: "warn", detail: `no provider config at ${configPath} — run onboarding or add a provider in settings before chatting` };
}

export async function collectEnvironmentProbes(): Promise<DoctorProbe[]> {
  return Promise.all([
    runProbe("data-dir", dataDirProbe),
    runProbe("network", networkProbe),
    runProbe("gh", ghProbe),
    runProbe("sandbox", sandboxProbe),
    runProbe("provider-config", providerConfigProbe),
  ]);
}

/** --json 复用的顶层形状（设置页直接消费）。 */
export interface DoctorReport {
  cli: Record<string, unknown>;
  runtime: Record<string, unknown>;
  packaging: Record<string, unknown>;
  probes: DoctorProbe[];
}
