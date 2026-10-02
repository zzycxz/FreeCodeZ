import type { SpawnOptions } from "node:child_process";
import type { ZCodeToolExecResource } from "@zcode/shared";
import type { NetworkEgressEnvPolicy } from "../network/subprocess-env.js";
import type { ResolvedSpawnCommand } from "./execution-command.js";
import type {
  BackgroundExecutionSnapshot,
  BackgroundExecutionStartResult,
  ExecutionResult,
  ExecutionRunOptions,
  ExecutionShellDialect,
} from "@zcode/contracts";

export interface ExitState {
  code?: number;
  signal?: string;
  error?: Error;
}

export interface BackgroundTaskRecord extends BackgroundExecutionSnapshot {
  sessionId?: string;
  isBash: boolean;
  legacyOutputEncoding: string | null;
  completion: Promise<BackgroundExecutionSnapshot>;
  controller: AbortController;
  externalAbort?: () => void;
  resolveCompletion: (snapshot: BackgroundExecutionSnapshot) => void;
}

export interface ExecutionOutputPaths {
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
}

export interface InternalExecutionRunOptions extends ExecutionRunOptions {
  onOutputEncodingResolved?: (encoding: string | null) => void;
  /** Bash 移交时停止前台预览并重启文件 watchdog；不复制进程或输出。 */
  bashLifecycle?: {
    isBackgrounded: () => boolean;
    onBackgrounded?: () => void;
    onExit?: () => void;
  };
  onPersistedLimit?: () => void;
  sharePersistedOutputLimitAcrossStreams?: boolean;
  shouldStopOnPersistedLimit?: () => boolean;
  shouldRetainExecutionAfterRootExit?: () => boolean;
}

export type BashBackgroundLifecycleMode = "explicit" | "auto_on_timeout";

export type BashBackgroundLifecycleResult =
  | {
      kind: "foreground";
      result: ExecutionResult;
    }
  | {
      kind: "backgrounded";
      task: BackgroundExecutionStartResult;
    };

export interface PreparedChildSpawn {
  command: ResolvedSpawnCommand;
  cwdDialect: ExecutionShellDialect;
  cwdFilePath?: string;
  spawnOptions: SpawnOptions;
  /** E-S1/S4：沙箱包装结果。applied=false 且 skippedReason 非 "disabled" 时表示
   * 显式请求了沙箱但无法满足（fail-open），调用方可观测留痕。 */
  sandbox?: {
    applied: boolean;
    skippedReason?:
      | "disabled"
      | "non-darwin"
      | "sandbox-exec-missing"
      | "no-workspace-root"
      | "unsupported-platform";
  };
}

export interface ActiveExecutionRecord {
  completion: Promise<void>;
  resolveCompletion: () => void;
  stop: (reason: StopReason) => void;
}

export interface NodeExecutionAdapterOptions {
  onToolExecResource?: (sample: ZCodeToolExecResource) => void;
  outputRootDir?: string;
  maxPersistedOutputBytes?: number;
  network?: NetworkEgressEnvPolicy;
  platform?: NodeJS.Platform;
  processEnv?: NodeJS.ProcessEnv;
  progressIntervalMs?: number;
  progressTailBytes?: number;
  progressThresholdMs?: number;
}

export type OutputPersistenceMode = "none" | "on_truncate" | "always";

export type StopReason = "timeout" | "cancelled" | "output_limit";
