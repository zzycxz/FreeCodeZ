import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { decodeExecutionOutputBuffer } from "./outputEncoding.js";
import type { OutputPersistenceMode } from "./execution-adapter-types.js";
import type { ExecutionStreamResult } from "@zcode/contracts";

export interface AggregatePersistedOutputBudget {
  bytes: number;
  maxBytes: number;
}

export class OutputCollector {
  // B3：inline 缓冲由“纯头部”改为首尾对称保留（各 maxInlineBytes/2），中段丢弃并计
  // omittedBytes。纯头部截断会丢日志尾部——编译/测试错误常在中后段；全量始终落盘
  // artifact（原有行为不变），inline 只是模型可见窗口。未发生省略时 head+tail 连续
  // 拼接，与旧行为逐字节一致。
  private readonly headChunks: Buffer[] = [];
  private headBytes = 0;
  private inlineTail = Buffer.alloc(0);
  private omittedMiddleBytes = 0;
  private readonly maxHeadBytes: number;
  private readonly maxInlineTailBytes: number;
  private readonly maxPersistedBytes: number;
  private readonly maxTailBytes: number;
  private readonly legacyOutputEncoding: string | null;
  private onPersistedLimit?: () => void;
  private readonly outputPath?: string;
  private readonly persistOutput: OutputPersistenceMode;
  private readonly aggregatePersistedBudget?: AggregatePersistedOutputBudget;
  private stream?: WriteStream;
  private artifactBytes = 0;
  private artifactTruncated = false;
  private persistenceActive = false;
  private tail = Buffer.alloc(0);
  private totalBytes = 0;

  constructor(options: {
    maxInlineBytes: number;
    maxPersistedBytes: number;
    legacyOutputEncoding: string | null;
    maxTailBytes: number;
    onPersistedLimit?: () => void;
    outputPath?: string;
    persistOutput: OutputPersistenceMode;
    aggregatePersistedBudget?: AggregatePersistedOutputBudget;
  }) {
    const maxInline = Math.max(0, options.maxInlineBytes);
    this.maxHeadBytes = Math.floor(maxInline / 2);
    this.maxInlineTailBytes = maxInline - this.maxHeadBytes;
    this.maxPersistedBytes = Math.max(0, options.maxPersistedBytes);
    this.maxTailBytes = Math.max(0, options.maxTailBytes);
    this.legacyOutputEncoding = options.legacyOutputEncoding;
    this.onPersistedLimit = options.onPersistedLimit;
    this.outputPath = options.outputPath;
    this.persistOutput = options.persistOutput;
    this.aggregatePersistedBudget = options.aggregatePersistedBudget;
  }

  append(chunk: Buffer, source?: NodeJS.ReadableStream): void {
    const shouldStartPersisting =
      this.persistOutput === "always" ||
      (this.persistOutput === "on_truncate" &&
        this.heldInlineBytes() + chunk.byteLength > this.maxInlineBytes());

    if (shouldStartPersisting) this.activatePersistence(source);

    this.totalBytes += chunk.byteLength;
    this.appendTail(chunk);

    const remainingHead = this.maxHeadBytes - this.headBytes;
    if (remainingHead > 0) {
      const take = Math.min(remainingHead, chunk.byteLength);
      if (take > 0) {
        this.headChunks.push(chunk.subarray(0, take));
        this.headBytes += take;
      }
      if (take < chunk.byteLength) {
        this.appendInlineTail(chunk.subarray(take));
      }
    } else if (chunk.byteLength > 0) {
      this.appendInlineTail(chunk);
    }
    if (this.persistenceActive) this.writePersisted(chunk, source);
  }

  async close(): Promise<void> {
    if (!this.stream) return;
    await new Promise<void>((resolve) => {
      this.stream!.end(resolve);
    });
  }

  result(): ExecutionStreamResult {
    const hasArtifact = this.stream !== undefined;
    // truncated 语义收紧为“inline 有字节未保留”：head+tail 尚能容纳全部输出时
    // 不再标记截断（旧实现 head 一满即标，即使随后未再输出）。
    if (this.omittedMiddleBytes === 0) {
      return {
        text: decodeExecutionOutputBuffer(this.concatHeldInline(), this.legacyOutputEncoding),
        bytes: this.totalBytes,
        truncated: false,
        artifactPath: hasArtifact ? this.outputPath : undefined,
        artifactBytes: hasArtifact ? this.artifactBytes : undefined,
        artifactTruncated: hasArtifact ? this.artifactTruncated : undefined,
      };
    }

    // head|tail 拼接处可能切断多字节 UTF-8 序列：先裁掉残缺边界（计入省略数），
    // 避免 decode 产生替换字符污染模型可见文本。
    const head = trimTrailingPartialUtf8(Buffer.concat(this.headChunks, this.headBytes));
    const tail = trimLeadingPartialUtf8(this.inlineTail);
    const omitted = this.omittedMiddleBytes + head.removed + tail.removed;
    const text =
      decodeExecutionOutputBuffer(head.buffer, this.legacyOutputEncoding) +
      `\n…[${omitted} bytes omitted]…\n` +
      decodeExecutionOutputBuffer(tail.buffer, this.legacyOutputEncoding);
    return {
      text,
      bytes: this.totalBytes,
      truncated: true,
      omittedBytes: omitted,
      artifactPath: hasArtifact ? this.outputPath : undefined,
      artifactBytes: hasArtifact ? this.artifactBytes : undefined,
      artifactTruncated: hasArtifact ? this.artifactTruncated : undefined,
    };
  }

  get bytes(): number {
    return this.totalBytes;
  }

  tailText(): string | undefined {
    if (this.tail.length === 0) return undefined;
    return decodeExecutionOutputBuffer(this.tail, this.legacyOutputEncoding);
  }

  private maxInlineBytes(): number {
    return this.maxHeadBytes + this.maxInlineTailBytes;
  }

  private heldInlineBytes(): number {
    return this.headBytes + this.inlineTail.byteLength;
  }

  private concatHeldInline(): Buffer {
    const total = this.heldInlineBytes();
    if (total === 0) return Buffer.alloc(0);
    return Buffer.concat([...this.headChunks, this.inlineTail], total);
  }

  private appendInlineTail(part: Buffer): void {
    if (part.byteLength === 0) return;
    const next =
      this.inlineTail.byteLength === 0 ? Buffer.from(part) : Buffer.concat([this.inlineTail, part]);
    if (next.byteLength > this.maxInlineTailBytes) {
      const overflow = next.byteLength - this.maxInlineTailBytes;
      this.omittedMiddleBytes += overflow;
      this.inlineTail = Buffer.from(next.subarray(overflow));
    } else {
      this.inlineTail = next;
    }
  }

  private appendTail(chunk: Buffer): void {
    if (this.maxTailBytes <= 0 || chunk.byteLength === 0) return;
    const next = this.tail.length === 0 ? chunk : Buffer.concat([this.tail, chunk]);
    this.tail =
      next.byteLength > this.maxTailBytes
        ? Buffer.from(next.subarray(next.byteLength - this.maxTailBytes))
        : Buffer.from(next);
  }

  private ensurePersistedStream(): void {
    if (this.stream || !this.outputPath || this.maxPersistedBytes <= 0) return;

    mkdirSync(dirname(this.outputPath), { recursive: true });
    this.stream = createWriteStream(this.outputPath, { flags: "w" });
    this.stream.on("error", () => {
      this.artifactTruncated = true;
    });
  }

  private activatePersistence(source?: NodeJS.ReadableStream): void {
    if (this.persistenceActive) return;
    this.ensurePersistedStream();
    if (!this.stream) return;
    this.persistenceActive = true;
    // 回放已持有的 inline 缓冲（head + tail）保证 artifact 是完整前缀流。
    for (const chunk of this.headChunks) {
      this.writePersisted(chunk, source);
    }
    if (this.inlineTail.byteLength > 0) {
      this.writePersisted(this.inlineTail, source);
    }
  }

  private writePersisted(chunk: Buffer, source?: NodeJS.ReadableStream): void {
    if (!this.stream || chunk.byteLength === 0 || this.artifactTruncated) {
      return;
    }

    // 通用 pipe 执行仍在写盘前限制单路和共享预算；Bash 文件软阈值不经过这里。
    const streamRemaining = this.maxPersistedBytes - this.artifactBytes;
    const aggregateRemaining = this.aggregatePersistedBudget
      ? this.aggregatePersistedBudget.maxBytes - this.aggregatePersistedBudget.bytes
      : streamRemaining;
    const remaining = Math.min(streamRemaining, aggregateRemaining);
    if (remaining <= 0) {
      this.artifactTruncated = true;
      this.notifyPersistedLimit();
      return;
    }

    const take = Math.min(remaining, chunk.byteLength);
    const persistedChunk = chunk.subarray(0, take);
    this.artifactBytes += persistedChunk.byteLength;
    if (this.aggregatePersistedBudget) {
      this.aggregatePersistedBudget.bytes += persistedChunk.byteLength;
    }
    if (take < chunk.byteLength) {
      this.artifactTruncated = true;
      this.notifyPersistedLimit();
    }

    const canContinue = this.stream.write(persistedChunk);
    if (!canContinue && source) {
      source.pause();
      this.stream.once("drain", () => source.resume());
    }
  }

  private notifyPersistedLimit(): void {
    if (!this.onPersistedLimit) return;
    const callback = this.onPersistedLimit;
    this.onPersistedLimit = undefined;
    callback();
  }
}

// ---- UTF-8 边界裁剪：head|tail 拼接处可能切断多字节序列，裁掉残缺字节避免替换字符 ----

function isUtf8LeadByte(byte: number): boolean {
  return byte >= 0xc0 && byte <= 0xf7;
}

function utf8SequenceLength(leadByte: number): number {
  if (leadByte >= 0xf0) return 4;
  if (leadByte >= 0xe0) return 3;
  return 2;
}

function trimTrailingPartialUtf8(buffer: Buffer): { buffer: Buffer; removed: number } {
  const maxScan = Math.min(3, buffer.byteLength);
  for (let n = 1; n <= maxScan; n++) {
    const byte = buffer[buffer.byteLength - n];
    if (byte < 0x80) return { buffer, removed: 0 }; // ASCII 结尾必然完整
    if (isUtf8LeadByte(byte)) {
      return utf8SequenceLength(byte) > n
        ? { buffer: buffer.subarray(0, buffer.byteLength - n), removed: n }
        : { buffer, removed: 0 };
    }
    // 0x80-0xBF 连续字节：继续向左找它的 lead。
  }
  return { buffer, removed: 0 };
}

function trimLeadingPartialUtf8(buffer: Buffer): { buffer: Buffer; removed: number } {
  const maxScan = Math.min(3, buffer.byteLength);
  let removed = 0;
  for (let n = 0; n < maxScan; n++) {
    const byte = buffer[n];
    if (byte < 0x80) break; // ASCII：前面扫过的连续字节即残缺前缀
    if (isUtf8LeadByte(byte)) break; // 完整序列的 lead：残缺前缀到此为止
    removed = n + 1; // 连续字节（0x80-0xBF）：属于被省略区里的 lead
  }
  return removed > 0
    ? { buffer: buffer.subarray(removed), removed }
    : { buffer, removed: 0 };
}
