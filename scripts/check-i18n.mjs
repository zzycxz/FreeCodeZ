#!/usr/bin/env node
// i18n 一致性校验（升级实施手册 条目2⑥）：
// ① packages/ui：两个 locale 扁平键集完全一致（缺失/多余都报，含死键方向提示）；
// ② apps/zcode-cli/packages/i18n：ZCodeCopy 树的路径集合一致 + 函数值参数个数一致
//   （fn.length；函数体形态 TS 类型已约束，脚本补的是"运行时形状"这层）。
// 值采用运行时 import（tsx）——零正则解析盲区，双/单引号与函数值天然覆盖。
// 挂点：verify:pre-push；单跑：pnpm i18n:check。
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

async function importModule(relativePath) {
  const module = await import(pathToFileURL(resolve(repoRoot, relativePath)).href);
  if (module.default !== undefined) return module.default;
  // 具名导出（enUS/zhCN）：剥掉导出名这一层，直接取对象本体。
  const named = Object.keys(module).filter((key) => key !== "__esModule");
  return named.length === 1 ? module[named[0]] : module;
}

function flattenKeys(value, prefix = "", out = new Map()) {
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flattenKeys(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  const arity = typeof value === "function" ? value.length : undefined;
  out.set(prefix, { kind: typeof value === "function" ? "fn" : typeof value, arity });
  return out;
}

function diffKeySets(name, left, right) {
  const leftKeys = new Set(left.keys());
  const rightKeys = new Set(right.keys());
  const missingInRight = [...leftKeys].filter((key) => !rightKeys.has(key));
  const missingInLeft = [...rightKeys].filter((key) => !leftKeys.has(key));
  const arityMismatch = [...leftKeys]
    .filter((key) => rightKeys.has(key))
    .filter((key) => {
      const l = left.get(key);
      const r = right.get(key);
      return l.kind !== r.kind || (l.kind === "fn" && l.arity !== r.arity);
    })
    .map((key) => `${key}（${left.get(key).kind}/${left.get(key).arity} vs ${right.get(key).kind}/${right.get(key).arity}）`);
  if (missingInRight.length === 0 && missingInLeft.length === 0 && arityMismatch.length === 0) {
    console.log(`[i18n:check] ${name}: OK（${leftKeys.size} 键，双语对称）`);
    return true;
  }
  console.error(`[i18n:check] ${name}: FAIL`);
  for (const key of missingInRight) console.error(`  en-US 缺失: ${key}`);
  for (const key of missingInLeft) console.error(`  zh-CN 缺失: ${key}`);
  for (const key of arityMismatch) console.error(`  形状不一致: ${key}`);
  return false;
}

let ok = true;

// —— 包一：packages/ui 扁平键 ——
const uiEn = await importModule("packages/ui/src/i18n/locales/en-US.ts");
const uiZh = await importModule("packages/ui/src/i18n/locales/zh-CN.ts");
ok = diffKeySets("packages/ui", flattenKeys(uiZh), flattenKeys(uiEn)) && ok;

// —— 包二：apps/zcode-cli/packages/i18n（ZCodeCopy 树 + 函数值）——
const cliEn = await importModule("apps/zcode-cli/packages/i18n/src/locales/en-US.ts");
const cliZh = await importModule("apps/zcode-cli/packages/i18n/src/locales/zh-CN.ts");
ok = diffKeySets("apps/zcode-cli/packages/i18n", flattenKeys(cliZh), flattenKeys(cliEn)) && ok;

if (!ok) {
  console.error("[i18n:check] 存在不对称键，请补齐或删除双侧同名键。");
  process.exit(1);
}
