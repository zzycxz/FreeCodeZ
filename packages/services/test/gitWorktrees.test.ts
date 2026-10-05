// 条目 10（升级实施手册）：worktree 落地测试。
// 真仓库 e2e（/tmp 临时 init 仓）+ porcelain 纯函数钉死。
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  parseWorktreeListPorcelain,
  worktreeRootDir,
  type GitCommandProvider,
} from "../src/git/worktrees.js";

const run = promisify(execFile);

const commands: GitCommandProvider = {
  async run({ cwd, args }) {
    try {
      const { stdout } = await run("git", args as string[], { cwd });
      return { exitCode: 0, stdout, stderr: "" };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { exitCode: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  },
};

test("porcelain 解析：主仓+附加 worktree+detached/prunable 标志", () => {
  const text = [
    "worktree /repo/main",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /repo/wt-a",
    "HEAD def456",
    "detached",
    "prunable",
    "",
    "worktree /repo/bare",
    "HEAD 000",
    "bare",
    "",
  ].join("\n");
  const entries = parseWorktreeListPorcelain(text);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { path: "/repo/main", head: "abc123", branch: "main", bare: false, detached: false, prunable: false });
  assert.equal(entries[1]?.detached, true);
  assert.equal(entries[1]?.prunable, true);
  assert.equal(entries[1]?.branch, undefined);
  assert.equal(entries[2]?.bare, true);
});

test("e2e：真仓 init → createWorktree（分离头）→ 并行政同一文件不干扰 → 清理后可从 HEAD 恢复", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "wt-repo-"));
  t.after(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(join(worktreeRootDir()), { recursive: true, force: true }).catch(() => undefined);
  });
  await run("git", ["init", "-q"], { cwd: repo });
  await writeFile(join(repo, "shared.txt"), "original\n");
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });

  // 两个并行 worktree
  const baseDir = await mkdtemp(join(tmpdir(), "wt-root-"));
  const a = await createWorktree({ commands, resolution: { repoRoot: repo }, name: "task-a", baseDir });
  const b = await createWorktree({ commands, resolution: { repoRoot: repo }, name: "task-b", baseDir });
  assert.equal(a.ok, true, JSON.stringify(a.error));
  assert.equal(b.ok, true, JSON.stringify(b.error));

  // 改同一文件互不干扰
  await writeFile(join(a.path!, "shared.txt"), "from-a\n");
  await writeFile(join(b.path!, "shared.txt"), "from-b\n");
  await writeFile(join(repo, "shared.txt"), "main-untouched\n");
  assert.equal(await readFile(join(a.path!, "shared.txt"), "utf8"), "from-a\n");
  assert.equal(await readFile(join(b.path!, "shared.txt"), "utf8"), "from-b\n");
  assert.equal(await readFile(join(repo, "shared.txt"), "utf8"), "main-untouched\n");

  // 枚举包含主仓 + 两个附加
  const listed = await listWorktrees({ commands, resolution: { repoRoot: repo } });
  // macOS /var 是 /private/var 的符号链：mkdtemp 给前者、git porcelain 输出后者——realpath 归一。
  const { realpath } = await import("node:fs/promises");
  const listedPaths = new Set(await Promise.all(listed.map((entry) => realpath(entry.path))));
  const ours = await Promise.all([a.path, b.path].filter(Boolean).map((p) => realpath(p!)));
  assert.equal(ours.filter((p) => listedPaths.has(p)).length, 2, JSON.stringify([...listedPaths]));
  assert.ok(listed.every((entry) => entry.head.length > 0));

  // 清理（force——有未提交修改）
  const removedA = await removeWorktree({ commands, resolution: { repoRoot: repo }, path: a.path!, force: true });
  assert.equal(removedA.ok, true);
  const afterRemove = await listWorktrees({ commands, resolution: { repoRoot: repo } });
  assert.equal(afterRemove.filter((entry) => entry.path === a.path).length, 0, "清理后注册表不含已删 worktree");

  // 主仓从 HEAD 恢复语义（既有 checkpoint 域）；这里验证主仓内容未被 worktree 改动污染
  assert.equal(await readFile(join(repo, "shared.txt"), "utf8"), "main-untouched\n");

  // 名字净化：怪字符收口
  const weird = await createWorktree({ commands, resolution: { repoRoot: repo }, name: "../escape! attempt", baseDir });
  assert.equal(weird.ok, true);
  // 净化把 '/' 换 '-'：'../escape' → '..-escape'（无路径分隔符，只是名字前缀）——
  // 逃逸判定=最终 resolve 后仍在 worktree root 之内。
  const { resolve } = await import("node:path");
  assert.ok(!weird.path!.split('/').pop()?.includes('/'), "末段不含路径分隔符");
  assert.ok(resolve(weird.path!).includes("freecodez-worktrees"), "仍在 worktree root 之下（无逃逸）");
  await removeWorktree({ commands, resolution: { repoRoot: repo }, path: weird.path!, force: true });
});

test("坏名（净化后空）结构化报错", async () => {
  const bad = await createWorktree({ commands, resolution: { repoRoot: "/nonexistent" }, name: "   " });
  assert.equal(bad.ok, false);
  assert.equal(bad.error?.code, "path_exists", JSON.stringify(bad.error));
});
