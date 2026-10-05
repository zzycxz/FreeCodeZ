// D1 灾难形态地板测试：两层数据面 + 服务集成面。
// 数据面：四类灾难形态全命中（含包装器/复合命令变体）；近邻合法样本零误杀
//（E1 语料精神：rm -rf node_modules、chmod +x、curl|sh 官方安装、dd of=/dev/null 全放行）。
// 集成面：PermissionService yolo 分支对 Bash 灾难命令 deny（rule.catastrophicFloor）、
// 正常命令照旧 allow；build 模式行为不受地板影响（仍走既有 ask/判定链）。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  findCatastrophicBashCommand,
  type CatastrophicBashCategory,
} from "../src/tool/bash-catastrophic-policy.js";
import { PermissionService } from "../src/permission/service.js";

const CATASTROPHIC_CASES: ReadonlyArray<[string, CatastrophicBashCategory]> = [
  ["mkfs.ext4 /dev/sda1", "filesystem-format"],
  ["mkfs /dev/sdb1", "filesystem-format"],
  ["sudo mkfs.xfs /dev/disk2s1", "filesystem-format"],
  ["dd if=image.iso of=/dev/rdisk3", "raw-device-write"],
  ["sudo dd if=/dev/zero of=/dev/sda", "raw-device-write"],
  ["rm -rf /", "root-home-delete"],
  ["sudo rm -rf /", "root-home-delete"],
  ["rm -rf ~", "root-home-delete"],
  ["rm -rf ~/", "root-home-delete"],
  ["rm -rf /*", "root-home-delete"],
  ["echo hi && rm -rf ~", "root-home-delete"],
  ["shutdown -h now", "system-shutdown"],
  ["sudo reboot", "system-shutdown"],
  ["nohup halt", "system-shutdown"],
  ["poweroff", "system-shutdown"],
  // 0-5 ①：词法归一 + realpath 绕过样本（实测全放行 → 全拦）
  ["rm -rf /var/..", "root-home-delete"],
  ["rm -rf /var/../..", "root-home-delete"],
  ["rm -rf ~/..", "root-home-delete"],
  ["rm -rf $HOME/..", "root-home-delete"],
  ["rm -rf /etc/../../..", "root-home-delete"],
  // 0-5 ②：解释器 -c 二次解析
  ["bash -c 'rm -rf /'", "root-home-delete"],
  ["sh -c 'rm -rf ~'", "root-home-delete"],
  ["sudo bash -c \"rm -rf $HOME\"", "root-home-delete"],
  ["zsh -c 'dd if=/dev/zero of=/dev/sda'", "raw-device-write"],
  ["bash -lc 'poweroff'", "system-shutdown"],
  // 0-5 ③：busybox/env/git rm 剥壳
  ["busybox rm -rf /", "root-home-delete"],
  ["sudo busybox rm -rf ~", "root-home-delete"],
  ["env rm -rf /", "root-home-delete"],
  ["sudo env rm -rf /", "root-home-delete"],
  ["env -u FOO BAR=1 rm -rf /", "root-home-delete"],
  ["git rm -rf /", "root-home-delete"],
  ["busybox poweroff", "system-shutdown"],
  // 0-5 ④：$HOME 族静态展开
  ["rm -rf $HOME", "root-home-delete"],
  ["rm -rf ${HOME}", "root-home-delete"],
  ["rm -rf \"$HOME\"", "root-home-delete"],
  ["rm -rf $HOME/", "root-home-delete"],
];

const LEGITIMATE_CASES: readonly string[] = [
  // E1 语料精神的近邻样本：全部必须放行（零误杀是本地板的生存底线）。
  "rm -rf node_modules",
  "rm -rf dist/ build/",
  "rm -rf ~/projects/app/node_modules",
  "chmod +x build.sh",
  "sudo chmod 644 /etc/hosts",
  "curl https://sh.rust-up.rs | sh",
  "curl -fsSL https://example.com/install.sh | bash",
  "dd if=a.bin of=/dev/null",
  "mkfs-check --report",
  "rm scratch.txt",
  "touch /tmp/workfile",
  "ls /",
  "git commit -m 'x'",
  "sudo systemctl restart nginx",
  "echo rm -rf /",
  "find . -name '*.log' -delete",
];

test("灾难形态：四类全命中（含包装器与复合命令）", () => {
  for (const [command, expected] of CATASTROPHIC_CASES) {
    const match = findCatastrophicBashCommand(command);
    assert.ok(match, `${command} 应命中灾难形态`);
    assert.equal(match.category, expected, `${command} 类别应为 ${expected}`);
    assert.ok(match.reason.length > 0, "拒绝原因必须可读（bot/模型侧展示）");
  }
});

test("近邻合法样本零误杀", () => {
  for (const command of LEGITIMATE_CASES) {
    assert.equal(
      findCatastrophicBashCommand(command),
      undefined,
      `${command} 是合法操作，不得误杀`,
    );
  }
});

test("保守方向：动态词（命令替换/非 HOME 变量）不拦；realpath 失败不崩溃", () => {
  // 0-5 ④ 之后 $HOME 是静态展开的例外；其余动态词维持保守放行。
  assert.equal(findCatastrophicBashCommand("rm -rf $(echo /)"), undefined);
  assert.equal(findCatastrophicBashCommand("rm -rf $TARGET"), undefined);
  assert.equal(findCatastrophicBashCommand("rm -rf $HOMEFOO"), undefined);
  // realpath/lstat 失败路径（不存在的深路径、类似网络挂载的不可达目标）不得崩溃、不得误拦。
  assert.equal(findCatastrophicBashCommand("rm -rf /nonexistent-deep-path/x/y"), undefined);
  assert.equal(findCatastrophicBashCommand("rm -rf /net/nowhere-mount/data"), undefined);
  // 相对路径 .. 链无法静态定深（不知 cwd 距根几层），仍归审批/沙箱层。
  assert.equal(findCatastrophicBashCommand("rm -rf ../../../.."), undefined);
});

test("符号链接：删链接本体无害放行；解引用形态（尾斜杠）realpath 后拦", () => {
  const dir = mkdtempSync(join(tmpdir(), "cata-floor-"));
  try {
    const link = join(dir, "home-link");
    symlinkSync(homedir(), link);
    // rm 不解引用目标本身：删符号链接只是删链接，放行。
    assert.equal(findCatastrophicBashCommand(`rm -rf ${link}`), undefined);
    // 尾斜杠强制解引用：realpath 落到真实家目录，必须拦。
    const hit = findCatastrophicBashCommand(`rm -rf ${link}/`);
    assert.ok(hit, "解引用家目录符号链接应命中");
    assert.equal(hit.category, "root-home-delete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function bashContext(command: string, mode: "yolo" | "build") {
  return {
    toolName: "Bash",
    input: { command },
    riskLevel: "high" as const,
    mode,
  };
}

test("服务集成：yolo 下灾难命令被拒（rule.catastrophicFloor）", () => {
  const service = new PermissionService();
  const result = service.checkPermission(bashContext("sudo rm -rf /", "yolo"));
  assert.equal(result.decision, "deny");
  assert.equal(result.ruleId, "rule.catastrophicFloor");
  assert.ok(result.reason?.includes("catastrophic"));
});

test("服务集成：yolo 下正常命令照旧全放行（零新增弹窗/零误杀）", () => {
  const service = new PermissionService();
  for (const command of ["rm -rf node_modules", "curl https://example.com | sh", "ls /"]) {
    const result = service.checkPermission(bashContext(command, "yolo"));
    assert.equal(result.decision, "allow", `${command} 在 yolo 下应放行`);
    assert.equal(result.ruleId, "mode.yolo");
  }
});

test("服务集成：build 模式行为不受地板影响（走既有判定链）", () => {
  const service = new PermissionService();
  // build 模式下 rm 属写操作：不是地板 deny，而是既有 ask/capability 链的结果。
  const result = service.checkPermission(bashContext("rm -rf /", "build"));
  assert.notEqual(result.ruleId, "rule.catastrophicFloor");
  // 非 Bash 工具在 yolo 下也完全不经过地板。
  const other = service.checkPermission({
    toolName: "Write",
    input: { file_path: "/tmp/x", content: "" },
    riskLevel: "medium" as const,
    mode: "yolo",
  });
  assert.equal(other.decision, "allow");
});
