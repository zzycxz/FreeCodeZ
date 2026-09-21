import type { ToolExecutionContext } from "../types.js";
import { MAX_MODEL_INPUT_CHARS, WEBFETCH_TOOL_NAME } from "./webfetch-constants.js";
import { webFetchError } from "./webfetch-errors.js";
import { traceFromContext } from "./webfetch-trace.js";

export function extractReadableContent(
  body: Uint8Array,
  contentType: string,
  format: "text" | "markdown" = "markdown",
): string {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!isTextLikeMime(mime)) {
    throw webFetchError("FetchFailed", `Unsupported WebFetch content type: ${mime || "unknown"}`, {
      contentType,
    });
  }

  const text = new TextDecoder().decode(body);
  if (mime === "text/html" || mime === "application/xhtml+xml" || contentType.includes("html")) {
    // FreeCodeZ fork(P6 §3.3):markdown 模式做正文抽取(nav/article/main 评分,
    // 对齐 Readability 语义的轻量实现——不引入 DOM 依赖,agent bundle 保持零原生依赖);
    // text 模式输出清洗后的纯文本。
    const extracted = extractHtmlMainContent(text);
    return format === "text" ? stripMarkdownToText(htmlToMarkdown(extracted)) : htmlToMarkdown(extracted);
  }
  return text.trim();
}

/**
 * 正文抽取(P6 §3.3 静态页路径):优先 <article>/<main>/[role=main]/#content,
 * 退化到 <body>;剔除 nav/header/footer/aside/script/style/form。无 DOM 依赖的
 * 启发式实现——覆盖 Readability 的主场景(文章/文档页),JS 重页面由调用方浏览器链兜底。
 */
export function extractHtmlMainContent(html: string): string {
  // \b 为字面正则词边界(勿改写为转义序列)。
  let content = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, "")
    .replace(/<header\b[\s\S]*?<\/header>/gi, "")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, "")
    .replace(/<form\b[\s\S]*?<\/form>/gi, "");

  const candidates: string[] = [];
  const article = content.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (article?.[1] && article[1].length > 200) candidates.push(article[1]);
  const main = content.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main?.[1] && main[1].length > 200) candidates.push(main[1]);
  const roleMain = content.match(/<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/\w+>/i);
  if (roleMain?.[1] && roleMain[1].length > 200) candidates.push(roleMain[1]);
  const body = content.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (body?.[1]) candidates.push(body[1]);

  if (candidates.length === 0) return content;
  // 取最长候选(正文块通常远大于次要区块)。
  return candidates.reduce((best, current) => (current.length > best.length ? current : best));
}

function stripMarkdownToText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[#>]+\s*/gm, "")
    .replace(/[*_`]/g, "");
}

export async function maybePersistRawContent(
  content: string,
  contentType: string,
  context: ToolExecutionContext,
): Promise<{ path?: string; uri: string } | undefined> {
  if (!context.artifactStore) return undefined;
  if (Buffer.byteLength(content, "utf8") <= MAX_MODEL_INPUT_CHARS) return undefined;

  const artifact = await context.artifactStore.writeToolResultArtifact(
    {
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.toolCallId,
      toolName: WEBFETCH_TOOL_NAME,
      content,
      contentType: contentType.includes("html") ? "text/markdown" : "text/plain",
      retention: "session",
      trace: traceFromContext(context),
    },
    { signal: context.abortSignal },
  );

  return { path: artifact.path, uri: artifact.uri };
}

export function truncateContentForModel(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_MODEL_INPUT_CHARS) {
    return { content, truncated: false };
  }

  const suffix = "\n\n[WebFetch content truncated before prompt processing]";
  const maxBodyChars = Math.max(0, MAX_MODEL_INPUT_CHARS - suffix.length);
  return {
    content: `${content.slice(0, maxBodyChars)}${suffix}`,
    truncated: true,
  };
}

function htmlToMarkdown(html: string): string {
  let content = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");

  content = content
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
    .replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n")
    .replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|header|footer|tr|table|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return decodeHtmlEntities(content)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, index, lines) => line.length > 0 || lines[index - 1]?.length !== 0)
    .join("\n")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    );
}

function isTextLikeMime(mime: string): boolean {
  if (mime.length === 0) return true;
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/xhtml+xml" ||
    mime === "application/javascript" ||
    mime === "application/x-javascript" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}
