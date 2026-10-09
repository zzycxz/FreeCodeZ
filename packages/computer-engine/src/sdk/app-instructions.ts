// FreeCodeZ W-27：app-instructions 注入器（FC 自有件）。G.1：get_app_state 命中目标
// 应用时随结果注入应用要点。资产在 docs/app-instructions/（来源披露见其 README）。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../docs/app-instructions",
);

/** bundle id（文件名）→ 展示名别名（大小写不敏感匹配）。 */
const APP_ALIASES: Record<string, readonly string[]> = {
  "com.apple.Safari": ["safari"],
  "com.apple.finder": ["finder"],
  "com.microsoft.VSCode": ["visual studio code", "code", "vscode"],
  "com.apple.Music": ["music"],
  "com.apple.clock": ["clock"],
  "com.apple.iWork.Numbers": ["numbers"],
  "com.spotify.client": ["spotify"],
  "com.tinyspeck.slackmacgap": ["slack"],
  "notion.id": ["notion"],
  "com.apple.ScreenContinuity": ["iphone mirroring", "screen continuity"],
};

const cache = new Map<string, string>();

function loadFile(bundleKey: string): string | undefined {
  const cached = cache.get(bundleKey);
  if (cached !== undefined) return cached;
  try {
    const text = readFileSync(join(DOCS_DIR, `${bundleKey}.md`), "utf8");
    cache.set(bundleKey, text);
    return text;
  } catch {
    return undefined;
  }
}

/** 按 bundle id 或应用名匹配并返回要点文本；未命中返回 undefined。 */
export function loadAppInstructions(app: {
  name?: string | undefined;
  bundleId?: string | undefined;
}): string | undefined {
  const bundleId = app.bundleId?.trim();
  if (bundleId) {
    const direct = loadFile(bundleId);
    if (direct !== undefined) return direct;
  }
  const name = app.name?.trim().toLowerCase();
  if (name) {
    for (const [bundleKey, aliases] of Object.entries(APP_ALIASES)) {
      if (aliases.includes(name)) {
        const text = loadFile(bundleKey);
        if (text !== undefined) return text;
      }
    }
  }
  return undefined;
}
