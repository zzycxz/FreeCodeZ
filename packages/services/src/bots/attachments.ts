// 入站附件处理（附录B §2.7 prepareBotMessageContent @744239）：
// ≤4 个 ×5MB，落盘 `<configDir>/bot-attachments/<botId>/<msgId>/<hash>-<name>`；
// image/audio 附 dataBase64+localPath 提供为多模态输入；行模板逐字取证自 host bundle。
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BotAttachment, BotActor, InboundMessage, ZCodePromptAttachment } from "./inboundTypes.js";
import { formatBotMessage, type BotHostLocale } from "./hostMessages.js";

export const ATTACHMENT_MAX_COUNT = 4;
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;

/** 文件名消毒：控制字符与 \/:*?"<>| → `_`，160 截断，空 → "attachment"。 */
export function sanitizeAttachmentFilename(name: string): string {
  const sanitized = Array.from(name.trim())
    .map((char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? "_" : char))
    .join("");
  return sanitized.length > 0 ? sanitized.slice(0, 160) : "attachment";
}

/** `x.xMB | ceil(KB)KB | xB | unknown size`。 */
export function formatAttachmentSize(sizeBytes: number | undefined): string {
  if (!sizeBytes || sizeBytes <= 0) return "unknown size";
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB`;
  if (sizeBytes >= 1024) return `${Math.ceil(sizeBytes / 1024)}KB`;
  return `${sizeBytes}B`;
}

/** 拒收原因归一：超 5MB → attachmentTooLarge；下载失败族 → attachmentDownloadUnavailable。 */
export function formatAttachmentRejectedReason(
  error: unknown,
  locale: BotHostLocale | undefined,
): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/exceeds 5MB/iu.test(message)) return formatBotMessage(locale, "attachmentTooLarge");
  if (
    /attachment download failed/iu.test(message) ||
    /file download failed/iu.test(message) ||
    /download .+ failed: HTTP/iu.test(message) ||
    /file download timed out/iu.test(message) ||
    /attachment download timed out/iu.test(message) ||
    /download .+ timed out/iu.test(message)
  ) {
    return formatBotMessage(locale, "attachmentDownloadUnavailable");
  }
  return message;
}

export function buildAttachmentCachePath(
  configDir: string,
  params: { botId: string; providerMessageId?: string; attachment: BotAttachment },
): string {
  const messageId = params.providerMessageId?.trim() || `message-${Date.now()}`;
  const hash = createHash("sha256")
    .update(`${params.botId}:${messageId}:${params.attachment.id}`)
    .digest("hex")
    .slice(0, 16);
  return join(
    configDir,
    "bot-attachments",
    sanitizeAttachmentFilename(params.botId),
    sanitizeAttachmentFilename(messageId),
    `${hash}-${sanitizeAttachmentFilename(params.attachment.filename)}`,
  );
}

export async function fetchAttachmentDownloadUrl(
  attachment: BotAttachment,
  fetchImpl: typeof fetch,
): Promise<Uint8Array | null> {
  if (!attachment.downloadUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchImpl(attachment.downloadUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`download ${attachment.filename} failed: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw (error as { name?: string }).name === "AbortError"
      ? new Error(`download ${attachment.filename} timed out.`)
      : error;
  } finally {
    clearTimeout(timer);
  }
}

export interface ResolvedAttachment {
  attachment: BotAttachment;
  data: Uint8Array;
}

export interface AttachmentDeps {
  configDir: string;
  fetchImpl: typeof fetch;
  /** 渠道自有下载（TG getFile / 飞书资源 / 微信 CDN 解密）；无实现时回落 downloadUrl。 */
  downloadAttachment?: (
    botId: string,
    attachment: BotAttachment,
    actor: BotActor,
  ) => Promise<ResolvedAttachment | null>;
}

export type BotAttachmentDeps = AttachmentDeps;

/** resolveAttachmentBytes（gr）：dataBase64 → localPath → 渠道下载 → downloadUrl。 */
export async function resolveAttachmentBytes(
  deps: AttachmentDeps,
  botId: string,
  attachment: BotAttachment,
  actor: BotActor,
): Promise<ResolvedAttachment | null> {
  if (attachment.dataBase64) {
    return { attachment, data: new Uint8Array(Buffer.from(attachment.dataBase64, "base64")) };
  }
  if (attachment.localPath) {
    return { attachment, data: new Uint8Array(await readFile(attachment.localPath)) };
  }
  const viaProvider = await deps.downloadAttachment?.(botId, attachment, actor);
  if (viaProvider) return viaProvider;
  const downloaded = await fetchAttachmentDownloadUrl(attachment, deps.fetchImpl);
  return downloaded ? { attachment, data: downloaded } : null;
}

/** cacheResolvedAttachment（pn）：落盘并回填 localPath/sizeBytes。 */
export async function cacheResolvedAttachment(
  deps: AttachmentDeps,
  params: { botId: string; message: InboundMessage; resolved: ResolvedAttachment },
): Promise<BotAttachment> {
  const localPath = buildAttachmentCachePath(deps.configDir, {
    botId: params.botId,
    providerMessageId: params.message.actor.providerMessageId,
    attachment: params.resolved.attachment,
  });
  await mkdir(join(localPath, ".."), { recursive: true });
  await writeFile(localPath, params.resolved.data);
  return {
    ...params.resolved.attachment,
    localPath,
    sizeBytes: params.resolved.data.byteLength,
  };
}

export interface PreparedBotMessageContent {
  content: string;
  zcodeAttachments: ZCodePromptAttachment[];
}

/**
 * prepareBotMessageContent（Pi）：
 * `content = [text.trim() || attachmentOnlyPrompt, ...附件行].join("\n\n")`；
 * image/audio → 多模态附件 + 「已作为图片/音频输入提供」行；其他 → 「已保存到」行；失败 → 「未能下载」行。
 */
export async function prepareBotMessageContent(
  deps: AttachmentDeps,
  botId: string,
  message: InboundMessage,
  locale: BotHostLocale | undefined,
): Promise<PreparedBotMessageContent> {
  const attachments = (message.attachments ?? []).slice(0, ATTACHMENT_MAX_COUNT);
  const zcodeAttachments: ZCodePromptAttachment[] = [];
  const lines: string[] = [];
  for (const attachment of attachments) {
    const resolved = await resolveAttachmentBytes(deps, botId, attachment, message.actor);
    if (!resolved) {
      lines.push(
        `附件：${attachment.filename} (${attachment.mimeType}, ${formatAttachmentSize(attachment.sizeBytes)})，未能下载。`,
      );
      continue;
    }
    if (resolved.data.byteLength > ATTACHMENT_MAX_BYTES) {
      throw new Error(`${resolved.attachment.filename} exceeds 5MB.`);
    }
    const cached = await cacheResolvedAttachment(deps, {
      botId,
      message,
      resolved,
    });
    const dataBase64 = Buffer.from(resolved.data).toString("base64");
    if (cached.kind === "image" || cached.kind === "audio") {
      zcodeAttachments.push({
        kind: cached.kind,
        filename: cached.filename,
        mimeType: cached.mimeType ?? "application/octet-stream",
        dataBase64,
        localPath: cached.localPath ?? "",
      });
      lines.push(
        `附件：${cached.filename} (${cached.mimeType}, ${formatAttachmentSize(cached.sizeBytes)})，已作为${
          cached.kind === "image" ? "图片" : "音频"
        }输入提供，并保存到：${cached.localPath}。如需读取附件，请直接使用这个本地路径，不要下载或访问临时/远程 URL。`,
      );
      continue;
    }
    lines.push(
      `附件：${cached.filename} (${cached.mimeType}, ${formatAttachmentSize(cached.sizeBytes)})，已保存到：${cached.localPath}`,
    );
  }
  const content = [
    message.text.trim() || (attachments.length > 0 ? formatBotMessage(locale, "attachmentOnlyPrompt") : ""),
    ...lines,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { content, zcodeAttachments };
}
