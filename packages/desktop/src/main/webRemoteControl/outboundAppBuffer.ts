import type { AppMessage } from "@zcode/shared/web-remote-control";

// 出站应用消息缓冲（附录A §7）：50 条 / 5s 窗口，超量丢最旧、超时未送达丢弃。
// 只缓冲应用层消息；rpc-frame/ack 走 AcknowledgedRelayProtocol 自己的重放缓冲（可靠层不双重入队）。

export interface OutboundAppBuffer {
  offer(message: AppMessage, trySend: (message: AppMessage) => boolean): void;
  flush(trySend: (message: AppMessage) => boolean): void;
  clear(): void;
}

interface OutboxEntry {
  message: AppMessage;
  queuedAt: number;
}

export function createOutboundAppBuffer(options: {
  maxEntries: number;
  windowMs: number;
  now(): number;
  logger: { warn(...args: unknown[]): void };
}): OutboundAppBuffer {
  let outbox: OutboxEntry[] = [];

  function prune(): void {
    const cutoff = options.now() - options.windowMs;
    outbox = outbox.filter((entry) => entry.queuedAt >= cutoff);
  }

  return {
    offer(message, trySend): void {
      if (trySend(message)) return;
      prune();
      if (outbox.length >= options.maxEntries) {
        outbox.shift();
        options.logger.warn("[web-remote-outbox] outbound buffer overflow, oldest dropped");
      }
      outbox.push({ message, queuedAt: options.now() });
    },
    flush(trySend): void {
      prune();
      const pending = outbox;
      outbox = [];
      for (const entry of pending) {
        if (!trySend(entry.message)) {
          outbox.push(entry);
        }
      }
    },
    clear(): void {
      outbox = [];
    },
  };
}
