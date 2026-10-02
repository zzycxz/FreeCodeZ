// D1 灾难形态地板测试：两层数据面 + 服务集成面。
// 数据面：四类灾难形态全命中（含包装器/复合命令变体）；近邻合法样本零误杀
//（E1 语料精神：rm -rf node_modules、chmod +x、curl|sh 官方安装、dd of=/dev/null 全放行）。
// 集成面：PermissionService yolo 分支对 Bash 灾难命令 deny（rule.catastrophicFloor）、
// 正常命令照旧 allow；build 模式行为不受地板影响（仍走既有 ask/判定链）。
import assert from "node:assert/strict";
import test from "node:test";
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

test("保守方向：解析不安全（动态词/语法错误）不拦", () => {
  // $HOME 是变量展开（动态词）——按 R3 保守规则不拦，交给审批/沙箱层。
  assert.equal(findCatastrophicBashCommand("rm -rf $HOME"), undefined);
  // 命令替换同理。
  assert.equal(findCatastrophicBashCommand("rm -rf $(echo /)"), undefined);
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
