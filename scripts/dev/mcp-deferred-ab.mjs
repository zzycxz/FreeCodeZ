// ============================================================
// MCP 目录态（deferred）A/B 对照实验台（spec §12 A/B 对照门控）
// ============================================================
// 目的：在目录态走向默认开启前，测量「工具选择准确率」是否因 schema 不注入
// 而下降（下降 >10 个百分点则不得开启）。
//
// 两臂（同一批任务、同一模型、temperature=0）：
//   arm-full     ：完整 name+多行 description+inputSchema 注入（现状，tool_choice=any 强制单选）。
//   arm-deferred ：产品真实目录段（packages/shared 的 buildMcpDirectoryLines/formatMcpDirectorySection
//                  ——一行描述截断 + 200 字符预算），仅注册 mention_tool(tool_name) 入口；
//                  选择后第二拍再把所选工具的 schema 给回模型生成参数
//                  （对应产品语义「schema 在首次调用时提供」）。
//
// 指标：
//   selectionAccuracy ：首工具名命中率（主指标，spec 门控）。
//   argsValidity      ：所选工具参数通过 inputSchema 校验率（required+type+enum）。
//   inputTokens       ：两臂 prompt 开销（目录态的收益面）。
//
// 工具面：两个（见 TOOL_SURFACES）——
//   issue-tracker（12 工具，规范描述+交叉引用行）：现实高质量 server 的画像；
//   data-platform（6 工具，简描述、无交叉引用）：劣质/极简 server 的画像，
//   选择信号主要落在工具名与 schema 上，用来探「schema 不注入」的真实风险区。
//
// 用法：node scripts/dev/mcp-deferred-ab.mjs [--models mimo-v2.6-flash,mimo-v2.6-pro]
// 凭据：读 ~/.freecodez/v2/provider_config.json（不落日志、不进结果文件）。
// 结果：scripts/dev/mcp-deferred-ab-results.json（无凭据、无密钥材料）。
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildMcpDirectoryLines, formatMcpDirectorySection } from "../../packages/shared/dist/mcp-directory.js";
import { TOOL_SURFACES, TASKS } from "./mcp-deferred-ab-fixtures.mjs";

// ---------- 输入 schema 校验（required + 基础 type + enum） ----------
function validateArgs(schema, args) {
  const errors = [];
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { valid: false, errors: ["args is not an object"] };
  }
  for (const key of schema.required ?? []) {
    if (!(key in args)) errors.push(`missing required: ${key}`);
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    const value = args[key];
    if (value === undefined) continue;
    const t = spec.type;
    const typeOk =
      t === "integer"
        ? Number.isInteger(value)
        : t === "number"
          ? typeof value === "number"
          : t === "string"
            ? typeof value === "string"
            : t === "boolean"
              ? typeof value === "boolean"
              : true;
    if (!typeOk) errors.push(`bad type: ${key} (want ${t})`);
    if (spec.enum && !spec.enum.includes(value)) errors.push(`bad enum: ${key}`);
  }
  return { valid: errors.length === 0, errors };
}

// ---------- Anthropic Messages 调用（带重试；不落凭据） ----------
async function callModel({ baseUrl, apiKey, model, system, tools, toolChoice, messages, maxTokens = 2048 }) {
  const body = {
    model,
    max_tokens: maxTokens,
    temperature: 0,
    system,
    messages,
    ...(tools && tools.length > 0 ? { tools, tool_choice: toolChoice ?? { type: "any" } } : {}),
  };
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          authorization: `Bearer ${apiKey}`,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
      return data;
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

function firstToolUse(message) {
  for (const block of message.content ?? []) {
    if (block.type === "tool_use") return block;
  }
  return null;
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

const SYSTEM_FULL =
  "你是工具调用选择器。针对用户请求，从可用工具中选择最合适的一个并发起调用；参数按请求内容给出。只调用一个工具。";
const SYSTEM_DEFERRED =
  "你是工具调用选择器。针对用户请求，从下方工具目录中选择最合适的一个工具，通过 mention_tool 说出它的名字；它的 schema 会在首次调用后提供。只选一个工具。";

// ---------- 单任务实验 ----------
async function runTask({ client, model, surface, task, arm }) {
  const tools = surface.tools;
  const record = { model, surface: surface.serverName, arm, prompt: task.prompt, expected: task.expected };
  if (arm === "full") {
    const message = await callModel({
      ...client,
      model,
      system: SYSTEM_FULL,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
      toolChoice: { type: "any" },
      messages: [{ role: "user", content: task.prompt }],
    });
    const toolUse = firstToolUse(message);
    const selected = toolUse?.name ?? null;
    const args = toolUse?.input ?? null;
    const schema = tools.find((t) => t.name === selected)?.inputSchema;
    record.selected = selected;
    record.selectionCorrect = selected === task.expected;
    record.args = args;
    record.argsValid = schema ? validateArgs(schema, args).valid : null;
    record.inputTokens = message.usage?.input_tokens ?? null;
    record.outputTokens = message.usage?.output_tokens ?? null;
    return record;
  }

  // arm-deferred 第一拍：目录段 + mention_tool 入口（产品 buildMcpDirectoryLines 截断语义）
  const { lines, truncated } = buildMcpDirectoryLines(
    tools.map((t) => ({ toolName: t.name, description: t.description })),
  );
  const directoryText = formatMcpDirectorySection({ serverName: surface.serverName, lines, truncated });
  const system = `${SYSTEM_DEFERRED}\n\n${directoryText}`;
  const phase1 = await callModel({
    ...client,
    model,
    system,
    tools: [
      {
        name: "mention_tool",
        description: "说出你要用的目录工具名（首次调用后会提供它的 schema）。",
        input_schema: {
          type: "object",
          properties: { tool_name: { type: "string" } },
          required: ["tool_name"],
        },
      },
    ],
    toolChoice: { type: "any" },
    messages: [{ role: "user", content: task.prompt }],
  });
  const mention = firstToolUse(phase1);
  const mentionInput = mention?.input ?? {};
  record.rawMention = mentionInput;
  const rawName = String(
    mentionInput.tool_name ?? mentionInput.toolName ?? mentionInput.name ?? mentionInput.tool ?? "",
  ).trim();
  const selected = tools.find((t) => t.name.toLowerCase() === rawName.toLowerCase())?.name ?? rawName;
  record.selected = selected || null;
  record.selectionCorrect = selected === task.expected;
  record.inputTokens = phase1.usage?.input_tokens ?? null;
  record.outputTokens = phase1.usage?.output_tokens ?? null;

  // 第二拍：把所选工具的 schema 给回模型生成参数（对应「首调用提供 schema」）
  const chosen = tools.find((t) => t.name === selected);
  if (!chosen) {
    record.args = null;
    record.argsValid = null;
    return record;
  }
  const phase2 = await callModel({
    ...client,
    model,
    system:
      "你选择了如下工具。请依据它的 schema 为本次用户请求生成调用参数。" +
      "只输出一个 JSON 对象，它是 input_schema 的实例（调用参数本身），不是调用请求包装；" +
      "不要输出错误说明或任何非参数内容；必填字段的值从用户请求文本中取。",
    tools: [],
    messages: [
      { role: "user", content: task.prompt },
      {
        role: "assistant",
        content: `工具：${chosen.name}\n描述：${chosen.description}\nschema：${JSON.stringify(chosen.inputSchema)}`,
      },
      { role: "user", content: "生成调用参数 JSON。" },
    ],
    maxTokens: 1024,
  });
  const text = (phase2.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const args = extractJson(text);
  record.args = args;
  record.argsValid = validateArgs(chosen.inputSchema, args).valid;
  record.outputTokens = (record.outputTokens ?? 0) + (phase2.usage?.output_tokens ?? 0);
  return record;
}

// ---------- 主流程 ----------
async function main() {
  const args = process.argv.slice(2);
  const modelArg = args.indexOf("--models");
  const models = modelArg >= 0 ? args[modelArg + 1].split(",") : ["mimo-v2.6-flash", "mimo-v2.6-pro"];
  const limitArg = args.indexOf("--limit");
  const taskList = limitArg >= 0 ? TASKS.slice(0, Number(args[limitArg + 1])) : TASKS;
  const runsArg = args.indexOf("--runs");
  const runs = runsArg >= 0 ? Math.max(1, Number(args[runsArg + 1])) : 1;
  const outArg = args.indexOf("--out");
  const outName = outArg >= 0 ? args[outArg + 1] : "mcp-deferred-ab-results.json";

  const providerConfig = JSON.parse(
    await readFile(join(homedir(), ".freecodez", "v2", "provider_config.json"), "utf8"),
  );
  const rule = providerConfig.config.providerConfigRules.providerRules[0].config;
  const client = { baseUrl: rule.api.baseUrl, apiKey: rule.access.apiKey };

  const surfaceMap = new Map(TOOL_SURFACES.map((s) => [s.serverName, s]));
  const results = [];
  for (const model of models) {
    for (let run = 1; run <= runs; run += 1) {
    for (const arm of ["full", "deferred"]) {
      for (const task of taskList) {
        const surface = surfaceMap.get(task.surface);
        const record = await runTask({ client, model, surface, task, arm });
        record.run = run;
        results.push(record);
        const mark = record.selectionCorrect ? "✓" : "✗";
        console.log(
          `${model} [${arm}] ${mark} ${task.surface}/${task.expected} ← ${record.selected ?? "∅"}` +
            (arm === "deferred" ? ` args=${record.argsValid ? "ok" : "bad"}` : ` args=${record.argsValid ? "ok" : "bad"}`),
        );
      }
    }
    }
  }

  // 汇总
  const summary = {};
  for (const model of models) {
    summary[model] = {};
    for (const arm of ["full", "deferred"]) {
      const rows = results.filter((r) => r.model === model && r.arm === arm);
      const selectionHits = rows.filter((r) => r.selectionCorrect).length;
      const argsChecked = rows.filter((r) => r.argsValid !== null);
      const argsHits = argsChecked.filter((r) => r.argsValid).length;
      summary[model][arm] = {
        tasks: rows.length,
        selectionHits,
        selectionAccuracy: selectionHits / rows.length,
        argsChecked: argsChecked.length,
        argsHits,
        argsValidity: argsChecked.length > 0 ? argsHits / argsChecked.length : null,
        avgInputTokens: Math.round(rows.reduce((s, r) => s + (r.inputTokens ?? 0), 0) / rows.length),
      };
    }
    summary[model].deltaSelectionAccuracy =
      summary[model].full.selectionAccuracy - summary[model].deferred.selectionAccuracy;
    summary[model].deltaInputTokens = summary[model].full.avgInputTokens - summary[model].deferred.avgInputTokens;
  }

  const output = {
    experiment: "mcp-deferred-ab",
    spec: "docs/spec/mcp-availability-first-cost-management.md §12",
    gate: "deferred 选择准确率相对 full 下降 >10 个百分点则不得默认开启",
    temperature: 0,
    models,
    runs,
    taskCount: taskList.length,
    surfaces: TOOL_SURFACES.map((s) => ({ serverName: s.serverName, toolCount: s.tools.length })),
    summary,
    results,
  };
  await writeFile(
    join(import.meta.dirname, outName),
    JSON.stringify(output, null, 2) + "\n",
    "utf8",
  );
  console.log("\n=== summary ===");
  for (const model of models) {
    const s = summary[model];
    console.log(
      `${model}: full ${s.full.selectionHits}/${s.full.tasks} (${(s.full.selectionAccuracy * 100).toFixed(1)}%) | ` +
        `deferred ${s.deferred.selectionHits}/${s.deferred.tasks} (${(s.deferred.selectionAccuracy * 100).toFixed(1)}%) | ` +
        `Δselection = ${(-s.deltaSelectionAccuracy * 100).toFixed(1)}pp | ` +
        `args full ${s.full.argsHits}/${s.full.argsChecked} deferred ${s.deferred.argsHits}/${s.deferred.argsChecked} | `,
    );
    console.log(`  ΔinputTokens = -${s.deltaInputTokens} (full ${s.full.avgInputTokens} → deferred ${s.deferred.avgInputTokens})`);
  }
}

await main();
