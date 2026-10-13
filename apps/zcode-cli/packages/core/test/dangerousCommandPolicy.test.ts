// U2-1（移植自 ZCode 3.15.1）guarded 危险命令引擎测试：上游 fvo 三态逐条对照——
// matched=规则命中（ask）/ unsupported=解析失败·动态词（保守放行，不询问）/
// notMatched=安全命令（等同 yolo 放行）；服务集成面四分支。
import assert from "node:assert/strict";
import test from "node:test";
import { matchDangerousCommand } from "../src/tool/dangerous-command-policy.js";
import { PermissionService } from "../src/permission/service.js";

function ruleOf(command: string): string | false | undefined {
  const result = matchDangerousCommand(command);
  return result.status === "matched" ? result.ruleId : result.status;
}

test("rm：递归旗标/多操作数/未引号 glob 命中，非递归单目标放行", () => {
  assert.equal(ruleOf("rm -r build"), "safety.bash.remove-critical-path");
  // 短旗标簇展开（上游 F4）：-rf → -r + -f
  assert.equal(ruleOf("rm -rf build"), "safety.bash.remove-critical-path");
  assert.equal(ruleOf("rm --recursive dir"), "safety.bash.remove-critical-path");
  assert.equal(ruleOf("sudo rm -Rf build"), "safety.bash.remove-critical-path");
  assert.equal(ruleOf("rm a b"), "safety.bash.remove-critical-path");
  assert.equal(ruleOf("rm *.log"), "safety.bash.remove-critical-path");
  assert.equal(ruleOf("rm build.log"), "notMatched");
  assert.equal(ruleOf("rm -f build.log"), "notMatched");
});

test("dd/mount/umount/mkfs → system-storage；help/空 mount 豁免", () => {
  assert.equal(ruleOf("dd if=x of=/dev/sda"), "safety.bash.system-storage");
  assert.equal(ruleOf("mkfs.ext4 /dev/sda"), "safety.bash.system-storage");
  assert.equal(ruleOf("umount /mnt"), "safety.bash.system-storage");
  assert.equal(ruleOf("mount /dev/sda /mnt"), "safety.bash.system-storage");
  assert.equal(ruleOf("mkfs --help"), "notMatched");
  assert.equal(ruleOf("dd --version"), "notMatched");
  assert.equal(ruleOf("mount"), "notMatched");
});

test("rsync --delete 族命中；-n/--dry-run 豁免；-an 簇展开后 -n 生效", () => {
  assert.equal(ruleOf("rsync -a --delete src/ dst/"), "safety.bash.rsync-delete");
  assert.equal(ruleOf("rsync --del a b"), "safety.bash.rsync-delete");
  assert.equal(ruleOf("rsync --delete-excluded a b"), "safety.bash.rsync-delete");
  assert.equal(ruleOf("rsync -n --delete src/ dst/"), "notMatched");
  assert.equal(ruleOf("rsync -an --delete src/ dst/"), "notMatched");
  assert.equal(ruleOf("rsync -a src/ dst/"), "notMatched");
});

test("git 规则族：reset --hard/clean -f/push force/checkout . /stash clear/worktree remove --force", () => {
  assert.equal(ruleOf("git reset --hard"), "safety.bash.git-reset-hard");
  assert.equal(ruleOf("git reset --hard HEAD~1"), "safety.bash.git-reset-hard");
  assert.equal(ruleOf("git reset --soft HEAD~1"), "notMatched");
  assert.equal(ruleOf("git reset"), "notMatched");
  assert.equal(ruleOf("git clean -f"), "safety.bash.git-clean-force");
  assert.equal(ruleOf("git clean -fd"), "safety.bash.git-clean-force");
  assert.equal(ruleOf("git clean -n"), "notMatched");
  assert.equal(ruleOf("git clean"), "notMatched");
  assert.equal(ruleOf("git push --force"), "safety.bash.git-push-force");
  assert.equal(ruleOf("git push -f origin main"), "safety.bash.git-push-force");
  assert.equal(ruleOf("git push origin +main"), "safety.bash.git-push-force");
  assert.equal(ruleOf("git push --force-with-lease"), "safety.bash.git-push-force");
  assert.equal(ruleOf("git push --mirror"), "safety.bash.git-push-force");
  assert.equal(ruleOf("git push --force --dry-run"), "notMatched");
  assert.equal(ruleOf("git push origin main"), "notMatched");
  assert.equal(ruleOf("git checkout ."), "safety.bash.git-discard-tree");
  assert.equal(ruleOf("git checkout -- ."), "safety.bash.git-discard-tree");
  assert.equal(ruleOf("git checkout -f"), "safety.bash.git-discard-tree");
  assert.equal(ruleOf("git checkout main"), "notMatched");
  assert.equal(ruleOf("git restore ."), "safety.bash.git-discard-tree");
  assert.equal(ruleOf("git restore --staged ."), "notMatched");
  assert.equal(ruleOf("git stash clear"), "safety.bash.git-stash-clear");
  assert.equal(ruleOf("git stash"), "notMatched");
  assert.equal(ruleOf("git worktree remove --force"), "safety.bash.git-worktree-force-remove");
  assert.equal(ruleOf("git worktree remove"), "notMatched");
});

test("find -delete 命中；未知谓词 unsupported；find 不带 -delete 放行", () => {
  assert.equal(ruleOf("find . -name '*.log' -delete"), "safety.bash.find-delete");
  assert.equal(ruleOf("find . -delete"), "safety.bash.find-delete");
  assert.equal(ruleOf("find . -name x"), "notMatched");
  assert.equal(ruleOf("find . -name x -weird-flag"), "unsupported");
});

test("解释器 -c 递归 + 包装器剥离 + 动态词保守 unsupported", () => {
  assert.equal(ruleOf("bash -c 'git reset --hard'"), "safety.bash.git-reset-hard");
  assert.equal(ruleOf("sudo git reset --hard"), "safety.bash.git-reset-hard");
  assert.equal(ruleOf("env GIT=x git clean -f"), "safety.bash.git-clean-force");
  assert.equal(ruleOf("rm -rf $TARGET"), "safety.bash.remove-critical-path");
  // 动态词且无规则命中 → unsupported（保守不询问；与 notMatched 区分保留）
  assert.equal(ruleOf("echo $HOME"), "unsupported");
});

test("服务集成：guarded 命中 ask / 未命中 allow / yolo 不受影响 / 灾难地板仍优先", () => {
  const service = new PermissionService();
  const base = {
    toolName: "Bash",
    input: { command: "placeholder" },
    riskLevel: "medium" as const,
  };
  const ask = service.checkPermission({
    ...base,
    input: { command: "git reset --hard" },
    mode: "guarded",
  });
  assert.equal(ask.decision, "ask");
  assert.equal(ask.ruleId, "safety.bash.git-reset-hard");

  const allowGuarded = service.checkPermission({
    ...base,
    input: { command: "ls -la" },
    mode: "guarded",
  });
  assert.equal(allowGuarded.decision, "allow");

  const yolo = service.checkPermission({
    ...base,
    input: { command: "git reset --hard" },
    mode: "yolo",
  });
  assert.equal(yolo.decision, "allow");

  const floor = service.checkPermission({
    ...base,
    input: { command: "mkfs.ext4 /dev/sda" },
    mode: "guarded",
  });
  assert.equal(floor.decision, "deny");
  assert.equal(floor.ruleId, "rule.catastrophicFloor");
});
