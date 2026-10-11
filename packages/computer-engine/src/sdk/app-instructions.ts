// FreeCodeZ W-27：app-instructions 注入器（FC 自有件）。G.1：get_app_state 命中目标
// 应用时随结果注入应用要点。资产在 docs/app-instructions/（来源披露见其 README）。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 默认按源码布局解析（src/sdk/ → 上2层=包根 → docs/app-instructions）。SDK 被 esbuild
// 打进 node_repl server bundle 后该相对深度失效（2026-10-11 装机审计 G3：docs 面静默
// 降级）——ComputerUseSdk 构造时若给了 docsRoot（bridge 从解析到的 sidecar 目录推导，
// build-sidecar 会把 docs 拷进 dist 随产物走）则覆盖此默认。
const DEFAULT_DOCS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../docs/app-instructions",
);
let docsDir = DEFAULT_DOCS_DIR;

/** 运行时重定位 docs 根（W-27/G3）：由 SDK 构造面传入打包态真实路径。 */
export function setAppInstructionsRoot(root: string): void {
  docsDir = resolve(root);
  cache.clear();
}

/** 当前生效的 docs 根（测试/诊断面）。 */
export function appInstructionsRoot(): string {
  return docsDir;
}

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
    const text = readFileSync(join(docsDir, `${bundleKey}.md`), "utf8");
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
