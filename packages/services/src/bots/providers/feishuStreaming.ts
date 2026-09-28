// 飞书/Lark 流式卡 sender（附录B §2.5 streaming_card 档）：
// 1s 节流（kle）、单请求 15s（Ple）、退避 1s·2^(n-1)（Cle）、连败 3 次熔断（ble）；
// >180 tagged 元素拆卡（splitFeishuStreamingCardStates，前卡 sealed）；permission/elicitation 打断先 seal。
import type { BotConfig } from "@zcode/shared/bots";
import type { BotHostLocale } from "../hostMessages.js";
import {
  buildFeishuStreamingCard,
  splitFeishuStreamingCardStates,
  type FeishuStreamingCardBlock,
  type FeishuStreamingCardState,
} from "./feishuProvider.js";

export const STREAMING_THROTTLE_MS = 1000;
export const STREAMING_REQUEST_TIMEOUT_MS = 15_000;
export const STREAMING_BACKOFF_BASE_MS = 1000;
export const STREAMING_CIRCUIT_THRESHOLD = 3;

export interface StreamingCardTransport {
  /** 创建卡片，返回 handle（message_id）；失败返回 null。 */
  create(bot: BotConfig, card: Record<string, unknown>, signal: AbortSignal): Promise<string | null>;
  update(
    bot: BotConfig,
    handle: string,
    card: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface BotStreamingSender {
  /** 是否已创建过卡片。 */
  readonly active: boolean;
  handleMessageChunk(content: string): void;
  handleTool(toolId: string): void;
  setToolSummaries(toolId: string, summary: string): void;
  setStatus(status: FeishuStreamingCardState["status"]): void;
  /** 同步到渠道（节流/退避/熔断内部处理）；force 跳过节流。 */
  sync(trigger: string, force?: boolean): Promise<void>;
  /** seal：以 sealed 状态收口当前卡（permission/elicitation/完成时）。 */
  seal(): Promise<void>;
}

export interface CreateFeishuStreamingSenderParams {
  bot: BotConfig;
  providerUserId: string;
  locale: BotHostLocale;
  transport: StreamingCardTransport;
  onWarn?: (message: string) => void;
}

export function createFeishuStreamingSender(
  params: CreateFeishuStreamingSenderParams,
): BotStreamingSender {
  const blocks: FeishuStreamingCardBlock[] = [];
  const toolSummaries = new Map<string, string>();
  const toolGroups = new Map<string, string[]>();
  let status: FeishuStreamingCardState["status"] = "running";
  let handle: string | null = null;
  let cardIndex = 0;
  let lastSyncAt = 0;
  let nextAllowedAt = 0;
  let failures = 0;
  let circuitOpen = false;
  let chain: Promise<void> = Promise.resolve();

  const buildState = (): FeishuStreamingCardState => ({
    providerUserId: params.providerUserId,
    locale: params.locale,
    blocks: blocks.map((block) =>
      block.type === "tools"
        ? {
            ...block,
            summaries: (toolGroups.get(block.title ?? "") ?? []).map(
              (toolId) => toolSummaries.get(toolId) ?? toolId,
            ),
          }
        : block,
    ),
    status,
  });

  const sync = (trigger: string, force = false): Promise<void> => {
    chain = chain.catch(() => undefined).then(async () => {
      if (!params.bot) return;
      const nowMs = Date.now();
      if (circuitOpen) return;
      if (!force && (nowMs < nextAllowedAt || (handle && nowMs - lastSyncAt < STREAMING_THROTTLE_MS))) {
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(new Error("Feishu streaming card request timed out."));
      }, STREAMING_REQUEST_TIMEOUT_MS);
      try {
        const states = splitFeishuStreamingCardStates(buildState());
        for (let index = Math.min(cardIndex, states.length - 1); index < states.length; index += 1) {
          const state = states[index] ?? buildState();
          const card = buildFeishuStreamingCard(state);
          if (!handle) {
            handle = await params.transport.create(params.bot, card, controller.signal);
            if (!handle) throw new Error("Feishu create streaming card returned no message_id.");
          } else {
            await params.transport.update(params.bot, handle, card, controller.signal);
          }
          if (index < states.length - 1) {
            cardIndex = index + 1;
            handle = null;
          }
        }
        lastSyncAt = Date.now();
        failures = 0;
        nextAllowedAt = 0;
      } catch (error) {
        failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (failures >= STREAMING_CIRCUIT_THRESHOLD) {
          circuitOpen = true;
          params.onWarn?.(
            `Feishu streaming card circuit opened trigger=${trigger} failures=${failures}: ${message}`,
          );
        } else {
          nextAllowedAt = Date.now() + STREAMING_BACKOFF_BASE_MS * 2 ** (failures - 1);
          params.onWarn?.(
            `Feishu streaming card sync failed trigger=${trigger} failures=${failures}: ${message}`,
          );
        }
      } finally {
        clearTimeout(timer);
      }
    });
    return chain;
  };

  const appendMessage = (content: string): void => {
    const last = blocks.at(-1);
    if (last?.type === "message") {
      last.text = `${last.text ?? ""}${content}`;
      return;
    }
    blocks.push({ type: "message", text: content });
  };

  return {
    get active() {
      return handle !== null;
    },
    handleMessageChunk: appendMessage,
    handleTool(toolId: string) {
      // tools 分组：把 toolId 归入最近的 tools 块（Sn appendStreamingCardTool）
      const last = blocks.at(-1);
      const groupKey = `tools-${blocks.length}`;
      if (last?.type === "tools") {
        toolGroups.get(last.title ?? "")?.push(toolId);
        return;
      }
      blocks.push({ type: "tools", title: groupKey, expanded: status === "running" });
      toolGroups.set(groupKey, [toolId]);
    },
    setToolSummaries(toolId: string, summary: string) {
      toolSummaries.set(toolId, summary);
    },
    setStatus(next) {
      status = next;
    },
    sync,
    async seal() {
      if (!handle) return;
      status = "sealed";
      await sync("seal", true);
      handle = null;
      cardIndex = 0;
      blocks.length = 0;
      status = "running";
      lastSyncAt = 0;
      nextAllowedAt = 0;
    },
  };
}
