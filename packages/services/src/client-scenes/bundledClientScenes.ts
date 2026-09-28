/**
 * Client Scenes 内置数据：定时任务模板 / 闲时任务模板 / 输入框推荐提示词。
 *
 * FreeCodeZ fork：这三类内容原由运行时请求 ZCode 后端
 * `GET {origin}/api/v1/client/scenes` 下发，而默认端点自 P4 §3.2 起是占位域
 * `https://freecodez.local`（不解析），请求必然失败，模板长期为空。
 * 按产品裁决（docs/spec/local-client-scenes.md）改为随包内置，不再外联。
 *
 * 数据快照自 `https://zcode.z.ai/api/v1/client/scenes`（2026-09-27，HTTP 200），
 * 只内置本仓库有消费方的三个 scene；其余 scene 全仓无读取方，不搬：
 *   - scheduled-task   → 定时任务模板（settings/automationTemplateCatalog）
 *   - off-peak-task    → 闲时任务模板（settings/automationTemplateCatalog）
 *   - draft-suggestion → 输入框推荐提示词（v4/draftSuggestedPromptItems）
 *
 * 静态产品内容：不做运行时路径解析、不接受环境变量覆盖（那条链路已在 provider
 * 配置上造成过两次故障）。
 */
import type { ClientSceneConfig } from "./clientScenes.js";

export const BUNDLED_CLIENT_SCENES: readonly ClientSceneConfig[] = [
  {
    namespace: "zcode",
    scene: "scheduled-task",
    options: {
      cronExpr: {
        id: "opt-cronExpr",
        type: "cronExpr",
        contents: {
          cn: "调度规则",
          en: "Schedule",
        },
        refer: "",
        cascades: {},
        items: [
          {
            id: "item-morningDevBrief-cronExpr",
            type: "cronExpr",
            contents: {
              cn: "0 9 * * 1-5",
              en: "0 9 * * 1-5",
            },
            labels: {
              cn: "工作日 09:00",
              en: "Weekdays at 09:00",
            },
          },
          {
            id: "item-dailyRiskScan-cronExpr",
            type: "cronExpr",
            contents: {
              cn: "0 10 * * *",
              en: "0 10 * * *",
            },
            labels: {
              cn: "每天 10:00",
              en: "Daily at 10:00",
            },
          },
          {
            id: "item-weeklyReleaseBrief-cronExpr",
            type: "cronExpr",
            contents: {
              cn: "0 16 * * 5",
              en: "0 16 * * 5",
            },
            labels: {
              cn: "每周五 16:00",
              en: "Fridays at 16:00",
            },
          },
          {
            id: "item-documentationSyncCheck-cronExpr",
            type: "cronExpr",
            contents: {
              cn: "0 15 * * 3",
              en: "0 15 * * 3",
            },
            labels: {
              cn: "每周三 15:00",
              en: "Wednesdays at 15:00",
            },
          },
        ],
        templates: {
          cn: "{prompt}",
          en: "{prompt}",
        },
      },
      prompts: {
        id: "opt-9fa513",
        type: "prompts",
        contents: {
          cn: "定时任务模板",
          en: "Scheduled task template",
        },
        refer: "",
        cascades: {},
        items: [
          {
            id: "item-morningDevBrief",
            type: "prompts",
            contents: {
              cn: "汇总上一个工作日以来的提交、模块变化、CI 状态和待跟进事项，最终生成不超过 6 条的晨会口述摘要。只读分析，只使用可验证的仓库事实；证据不足时明确说明，不推测，也不修改代码或外部状态。",
              en: "Summarize commits, module changes, CI status, and follow-ups since the previous workday, then produce no more than five stand-up-ready bullets. Perform read-only analysis using only verifiable repository facts; state when evidence is insufficient, do not speculate, and do not modify code or external state.",
            },
            labels: {
              cn: "晨会动态",
              en: "Morning dev brief",
            },
            defaults: {
              cronExpr: ["item-morningDevBrief-cronExpr"],
            },
          },
          {
            id: "item-dailyRiskScan",
            type: "prompts",
            contents: {
              cn: "检查最近 24 小时的代码变更，识别运行错误、数据丢失、权限绕过、资源泄漏及跨端兼容等高置信风险，并附代码和 commit/diff 证据。只读分析，只使用可验证的仓库事实；证据不足时明确说明，不推测，也不修改代码或外部状态。",
              en: "Inspect code changes from the last 24 hours for high-confidence risks involving runtime failures, data loss, authorization bypasses, resource leaks, or cross-platform compatibility, and attach code and commit/diff evidence. Perform read-only analysis using only verifiable repository facts; state when evidence is insufficient, do not speculate, and do not modify code or external state.",
            },
            labels: {
              cn: "风险扫描",
              en: "Risk scan",
            },
            defaults: {
              cronExpr: ["item-dailyRiskScan-cronExpr"],
            },
          },
          {
            id: "item-weeklyReleaseBrief",
            type: "prompts",
            contents: {
              cn: "整理本周合并的 PR 和 commit，按功能、修复、体验及工程改进分类，同时生成团队版和面向用户的精简发布说明。只读分析，只使用可验证的仓库事实；证据不足时明确说明，不推测，也不修改代码或外部状态。",
              en: "Organize PRs and commits merged this week into Features, Fixes, Experience improvements, and Engineering improvements, then produce both a team brief and concise user-facing release notes. Perform read-only analysis using only verifiable repository facts; state when evidence is insufficient, do not speculate, and do not modify code or external state.",
            },
            labels: {
              cn: "发布简报",
              en: "Release brief",
            },
            defaults: {
              cronExpr: ["item-weeklyReleaseBrief-cronExpr"],
            },
          },
          {
            id: "item-documentationSyncCheck",
            type: "prompts",
            contents: {
              cn: "对照最近 7 天的代码、配置、接口与文档变更，识别已改变公开行为但文档尚未同步的高置信差异，并附文件路径和 commit/diff 证据，给出应更新的文档位置与要点。只读分析，只使用可验证的仓库事实；证据不足时明确说明，不推测，也不修改代码或外部状态。",
              en: "Compare code, configuration, API, and documentation changes from the last seven days. Identify high-confidence cases where public behavior changed without matching documentation, attach file paths and commit/diff evidence, and name the documentation locations and key points that should be updated. Perform read-only analysis using only verifiable repository facts; state when evidence is insufficient, do not speculate, and do not modify code or external state.",
            },
            labels: {
              cn: "文档同步检查",
              en: "Documentation sync check",
            },
            defaults: {
              cronExpr: ["item-documentationSyncCheck-cronExpr"],
            },
          },
        ],
        templates: {
          cn: "{prompt}",
          en: "{prompt}",
        },
      },
    },
    created_at: 1786935503,
    updated_at: 1786935557,
  },
  {
    namespace: "zcode",
    scene: "off-peak-task",
    options: {
      prompts: {
        id: "opt-5c5e69",
        type: "prompts",
        contents: {
          cn: "闲时任务模板",
          en: "Idle-time task template",
        },
        refer: "",
        cascades: {},
        items: [
          {
            id: "item-standupGitSummary",
            type: "prompts",
            contents: {
              cn: "汇总本周 Git 活动，生成周五站会摘要：列出重要提交、已合并 PR 及主要变更，并保持简洁。",
              en: "Summarize this week's git activity into a Friday standup: notable commits, merged PRs, and what changed. Keep it concise.",
            },
            labels: {
              cn: "Git 站会摘要",
              en: "Standup Git Summary",
            },
          },
          {
            id: "item-ciFlakyReport",
            type: "prompts",
            contents: {
              cn: "扫描最近的 CI 运行，列出失败和不稳定测试及其可能原因，并按影响范围给出修复建议。",
              en: "Scan recent CI runs, list failing and flaky tests with likely causes, and propose fixes ranked by impact.",
            },
            labels: {
              cn: "CI 失败与不稳定测试报告",
              en: "CI Failures & Flaky Test Report",
            },
          },
          {
            id: "item-documentationSyncCheck",
            type: "prompts",
            contents: {
              cn: "基于当前代码实现和最近提交，检查仓库中的 README、docs、配置说明与使用示例是否过时或与实现不一致。仅修改能够从代码、配置或提交记录中直接确认的内容；不要猜测未验证的行为，并保持现有文档的结构、术语和写作风格。完成后列出修改的文件及每项修改依据；若无需修改，说明已检查的范围、证据与结论。",
              en: "Using the current implementation and recent commits as evidence, check whether README files, docs, configuration guidance, and usage examples are outdated or inconsistent with the code. Modify only content that can be directly verified from code, configuration, or commit history; do not infer unverified behavior, and preserve the existing document structure, terminology, and writing style. When finished, list the files changed and the evidence for each change. If no update is needed, report the scope checked, the evidence reviewed, and the conclusion.",
            },
            labels: {
              cn: "文档同步检查",
              en: "Documentation sync check",
            },
          },
        ],
        templates: {
          cn: "{prompt}",
          en: "{prompt}",
        },
      },
    },
    created_at: 1786935483,
    updated_at: 1786935576,
  },
  {
    namespace: "zcode",
    scene: "draft-suggestion",
    options: {
      plugins: {
        id: "opt-2c8a4b",
        type: "plugins",
        contents: {
          cn: "引用插件",
          en: "Referencing plugins",
        },
        refer: "",
        cascades: {},
        items: [
          {
            id: "item-017cd7",
            type: "plugins",
            contents: {
              cn: "github@zcode-plugins-official",
              en: "github@zcode-plugins-official",
            },
            labels: {
              cn: "Github",
              en: "Github",
            },
          },
          {
            id: "item-75f7f9",
            type: "plugins",
            contents: {
              cn: "document-skills@zcode-plugins-official",
              en: "document-skills@zcode-plugins-official",
            },
            labels: {
              cn: "文档技能",
              en: "Document Skills",
            },
          },
        ],
        templates: {
          cn: "{prompt}",
          en: "{prompt}",
        },
      },
      prompts: {
        id: "opt-Y7f2fe",
        type: "prompts",
        contents: {
          cn: "推荐提示词",
          en: "Recommended Prompts",
        },
        refer: "",
        cascades: {},
        items: [
          {
            id: "item-d325a7",
            type: "prompt",
            contents: {
              cn: "每周五总结这一周发生的事情。",
              en: "Summarize the events of the week every Friday.",
            },
            labels: {
              cn: "周报总结",
              en: "Weekly Summary",
            },
            img: "alarm-clock-check",
          },
          {
            id: "item-dd6512",
            type: "prompt",
            contents: {
              cn: "请分析以下终端报错日志，找出导致该错误的根本原因，并提供可以直接运行的修复代码示例。",
              en: "Please analyze the following terminal error log, find the root cause of the error, and provide a sample of fix code that can be run directly.",
            },
            labels: {
              cn: "报错修复",
              en: "Error Fix",
            },
            img: "bug",
          },
          {
            id: "item-4YwHmg",
            type: "prompt",
            contents: {
              cn: "帮我创建一份PPT，主题是「AI Agent 进化之路」，内容涵盖三个阶段：Prompt Engineering（起源、核心技巧、局限性）→ Context Engineering（为什么context更重要、RAG/Memory/Tool Use等关键技术）→ Harness Engineering（Agent框架演进、代表产品如AutoGPT/ACPAgent/OpenClaw）。风格科技感，深色背景，要有时间线贯穿",
              en: 'Please create a PowerPoint presentation for me on the topic "The Evolution of AI Agents," covering three stages: Prompt Engineering (origins, core techniques, limitations) → Context Engineering (why context is important, key technologies such as RAG/Memory/Tool Use) → Harness Engineering (agent framework evolution, representative products such as AutoGPT/ACPAgent/OpenClaw). The style should be tech-oriented, with a dark background, and a timeline should be clearly presented.',
            },
            labels: {
              cn: "PPT 制作",
              en: "PPT Creation",
            },
            img: "presentation",
            defaults: {
              plugins: ["item-75f7f9"],
            },
          },
          {
            id: "item-032195",
            type: "prompt",
            contents: {
              cn: "创建闲时任务",
              en: " Create Idle-time task",
            },
            labels: {
              cn: "闲时任务",
              en: "Idle-time task",
            },
            on_finish: "NAVIGATE:AUTOMATIONS:OFFPEAK",
            img: "moon",
          },
        ],
        templates: {
          cn: "{prompt}",
          en: "{prompt}",
        },
      },
    },
    created_at: 1787202353,
    updated_at: 1787202377,
  },
];
