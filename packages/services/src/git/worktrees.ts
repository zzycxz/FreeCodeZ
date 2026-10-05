// ============================================================
// 条目 10（升级实施手册）：Git worktree 落地
// ============================================================
// 方案（手册）：快照 ref 指针法（gitCheckpointRepo.ts:246-341 照抄改造）——
//   createWorktree：git worktree add <path> <ref>，ref 取当前 HEAD（分离头）；
//   并行任务在独立 worktree 改同一文件互不干扰；
//   快照恢复：worktree 的 hidden ref 由 checkpoint 系统管理（已有），worktree
//   自身删除走 git worktree remove --force（清 .git/worktrees 注册项）。
// 幽灵名同步清：provider-visible-order.ts 的 EnterWorktree/ExitWorktree 无实现，
// 本模块落地后由 worktree 工具批接 UI 时改接线（暂从清单摘除）。
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

export interface GitWorktreeCreateResult {
  ok: boolean;
  path?: string;
  error?: { code: "git_failed" | "path_exists"; message: string };
}

export interface GitWorktreeListEntry {
  path: string;
  head: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
}

export interface GitCommandProvider {
  run(input: { cwd: string; args: readonly string[] }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface WorktreeRepositoryResolution {
  repoRoot: string;
}

/** worktree 根目录（默认系统临时区的稳定前缀，便于排查与批量清理）。 */
export function worktreeRootDir(baseDir?: string): string {
  return resolve(baseDir ?? tmpdir(), "freecodez-worktrees");
}

/**
 * 创建 worktree：git worktree add <target> <ref>（分离头，不建分支——任务并行
// 语义不需要分支名，避免幽灵分支残留）。target = root/<name>；name 冲突结构化报错。
 */
export async function createWorktree(input: {
  commands: GitCommandProvider;
  resolution: WorktreeRepositoryResolution;
  name: string;
  ref?: string;
  baseDir?: string;
}): Promise<GitWorktreeCreateResult> {
  const safeName = input.name.trim().replace(/[^\w.-]/gu, "-");
  if (!safeName) {
    return { ok: false, error: { code: "path_exists", message: "worktree name is empty after sanitization" } };
  }
  const root = worktreeRootDir(input.baseDir);
  await mkdir(root, { recursive: true });
  const target = resolve(root, safeName);
  const ref = input.ref ?? "HEAD";
  const result = await input.commands.run({
    cwd: input.resolution.repoRoot,
    args: ["worktree", "add", "--detach", target, ref],
  });
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: { code: "git_failed", message: result.stderr.trim() || result.stdout.trim() || "git worktree add failed" },
    };
  }
  return { ok: true, path: target };
}

/** 枚举 worktree：porcelain 解析（纯函数钉测试）。 */
export function parseWorktreeListPorcelain(stdout: string): GitWorktreeListEntry[] {
  const entries: GitWorktreeListEntry[] = [];
  let current: Partial<GitWorktreeListEntry> | undefined;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current?.path) entries.push(current as GitWorktreeListEntry);
      current = { path: line.slice("worktree ".length).trim(), bare: false, detached: false, prunable: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length).trim();
    else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).trim().replace("refs/heads/", "");
    else if (line === "bare") current.bare = true;
    else if (line === "detached") current.detached = true;
    else if (line === "prunable") current.prunable = true;
  }
  if (current?.path) entries.push(current as GitWorktreeListEntry);
  return entries;
}

/** 列出 repo 全部 worktree。 */
export async function listWorktrees(input: {
  commands: GitCommandProvider;
  resolution: WorktreeRepositoryResolution;
}): Promise<GitWorktreeListEntry[]> {
  const result = await input.commands.run({
    cwd: input.resolution.repoRoot,
    args: ["worktree", "list", "--porcelain"],
  });
  if (result.exitCode !== 0) return [];
  return parseWorktreeListPorcelain(result.stdout);
}

/** 删除 worktree（--force：有未提交修改也清——调用方先确认）。 */
export async function removeWorktree(input: {
  commands: GitCommandProvider;
  resolution: WorktreeRepositoryResolution;
  path: string;
  force?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const result = await input.commands.run({
    cwd: input.resolution.repoRoot,
    args: ["worktree", "remove", ...(input.force ? ["--force"] : []), input.path],
  });
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr.trim() || "git worktree remove failed" };
  }
  return { ok: true };
}
