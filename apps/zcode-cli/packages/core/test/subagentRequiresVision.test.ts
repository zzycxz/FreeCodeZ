// §4.6 视觉子代理两级降级链（docs/spec/search-vision-settings.md）：
// 1) 行为面——requiresVision frontmatter 解析进 AgentProfile；
// 2) 产品面——四个办公插件随包发布的 visual-judge.md 不得再携带 account:* 账号套餐
//    模型 pin（FreeCodeZ 账号体系已删，该 pin 令子代理启动即 account-connection-unavailable），
//    必须是 model: inherit + requiresVision: true；
// 3) 结构锚——subagent.ts 的降级链入口必须按 profile.requiresVision 门控且显式
//    modelOverride 不参与替换（用户选择优先），防止后续改动悄悄绕过资格判定。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseAgentProfileFromMarkdown } from "../src/subagent/profile.js";

const here = dirname(fileURLToPath(import.meta.url));

const FRONTMATTER = (model: string, extra = "") => `---
name: probe
description: probe agent
model: ${model}
${extra}
---

body
`;

test("requiresVision 布尔解析：true 生效，false/缺省/垃圾值不生效", () => {
  assert.equal(
    parseAgentProfileFromMarkdown({
      content: FRONTMATTER("inherit", "requiresVision: true"),
      source: "user",
    }).profile?.requiresVision,
    true,
  );
  assert.equal(
    parseAgentProfileFromMarkdown({
      content: FRONTMATTER("inherit", "requiresVision: false"),
      source: "user",
    }).profile?.requiresVision,
    false,
  );
  assert.equal(
    parseAgentProfileFromMarkdown({
      content: FRONTMATTER("inherit", "requiresVision: yes-please"),
      source: "user",
    }).profile?.requiresVision,
    undefined,
  );
  assert.equal(
    parseAgentProfileFromMarkdown({
      content: FRONTMATTER("inherit"),
      source: "user",
    }).profile?.requiresVision,
    undefined,
  );
});

test("model: inherit 不产生 modelSelection（跟随父会话模型）", () => {
  const parsed = parseAgentProfileFromMarkdown({
    content: FRONTMATTER("inherit"),
    source: "user",
  });
  assert.equal(parsed.profile?.modelSelection, undefined);
});

test("四个随包 visual-judge.md：无账号 pin，inherit + requiresVision 就位", () => {
  const pluginRoots = [
    "../../documents-plugin",
    "../../pdf-plugin",
    "../../presentations-plugin",
    "../../spreadsheets-plugin",
  ] as const;
  for (const root of pluginRoots) {
    const path = join(here, root, "agents/visual-judge.md");
    const content = readFileSync(path, "utf8");
    assert.ok(!content.includes("account:"), `${path} 不得再硬编码账号套餐模型`);
    const parsed = parseAgentProfileFromMarkdown({ content, source: "built-in" });
    assert.equal(parsed.profile?.modelSelection, undefined, `${path} 应为 inherit`);
    assert.equal(parsed.profile?.requiresVision, true, `${path} 应声明 requiresVision`);
  }
});

test("结构锚：降级链按 requiresVision 门控且 modelOverride 不参与替换", () => {
  const source = readFileSync(
    join(here, "../src/runtime/methods/subagent.ts"),
    "utf8",
  );
  assert.match(
    source,
    /!modelOverride && request\.profile\.requiresVision === true/,
    "降级链入口必须同时满足：无显式 modelOverride 且 profile 声明 requiresVision",
  );
  assert.match(
    source,
    /visionUnderstandModel/,
    "降级链读取「搜索与视觉」分区的 visionUnderstandModel（零新增设置）",
  );
});
